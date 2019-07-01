import {
  makeSubject,
  map,
  pipe,
  publish,
  Source,
  Subject,
  scan,
  toPromise,
} from 'wonka';
import { Client } from '../client';
import {
  mutationOperation,
  mutationResponse,
  queryOperation,
  queryResponse,
  subscriptionOperation,
  subscriptionResult,
  undefinedQueryResponse,
} from '../test-utils';
import {
  Operation,
  OperationContext,
  OperationResult,
  GraphQLRequest,
} from '../types';
import { afterMutation, cacheExchange } from './cache';
import gql from 'graphql-tag';

let response;
let exchangeArgs;
let forwardedOperations: Operation[];
let reexecuteOperation;
let input: Subject<Operation>;

beforeEach(() => {
  response = queryResponse;
  forwardedOperations = [];
  reexecuteOperation = jest.fn();
  input = makeSubject<Operation>();

  // Collect all forwarded operations
  const forward = (s: Source<Operation>) => {
    return pipe(
      s,
      map(op => {
        forwardedOperations.push(op);
        return response;
      })
    );
  };

  const client = {
    reexecuteOperation: reexecuteOperation as any,
  } as Client;

  exchangeArgs = { forward, client };
});

describe('on query', () => {
  it('forwards to next exchange when no cache hit', () => {
    const [ops$, next, complete] = input;
    const exchange = cacheExchange(exchangeArgs)(ops$);

    publish(exchange);
    next(queryOperation);
    complete();
    expect(forwardedOperations.length).toBe(1);
    expect(reexecuteOperation).not.toBeCalled();
  });

  it('caches results', () => {
    const [ops$, next, complete] = input;
    const exchange = cacheExchange(exchangeArgs)(ops$);

    publish(exchange);
    next(queryOperation);
    next(queryOperation);
    complete();
    expect(forwardedOperations.length).toBe(1);
    expect(reexecuteOperation).not.toBeCalled();
  });

  describe('cache hit', () => {
    it('is miss when operation is forwarded', () => {
      const [ops$, next, complete] = input;
      const exchange = cacheExchange(exchangeArgs)(ops$);

      publish(exchange);
      next(queryOperation);
      complete();

      expect(forwardedOperations[0].context).toHaveProperty(
        'meta.cacheOutcome',
        'miss'
      );
    });

    it('is true when cached response is returned', async () => {
      const [ops$, next, complete] = input;
      const exchange = cacheExchange(exchangeArgs)(ops$);

      const results$ = pipe(
        exchange,
        scan((acc, x) => [...acc, x], [] as OperationResult[]),
        toPromise
      );

      publish(exchange);
      next(queryOperation);
      next(queryOperation);
      complete();

      const results = await results$;
      expect(results[1].operation.context).toHaveProperty(
        'meta.cacheOutcome',
        'hit'
      );
    });
  });
});

describe('on mutation', () => {
  it('does not cache', () => {
    response = mutationResponse;
    const [ops$, next, complete] = input;
    const exchange = cacheExchange(exchangeArgs)(ops$);

    publish(exchange);
    next(mutationOperation);
    next(mutationOperation);
    complete();
    expect(forwardedOperations.length).toBe(2);
    expect(reexecuteOperation).not.toBeCalled();
  });

  it('retriggers query operation', () => {
    const typename = 'ExampleType';
    const resultCache = new Map([[123, queryResponse]]);
    const operationCache = { [typename]: new Set([123]) };

    afterMutation(resultCache, operationCache, exchangeArgs.client)({
      ...mutationResponse,
      data: {
        todos: [
          {
            id: 1,
            __typename: typename,
          },
        ],
      },
    });

    expect(reexecuteOperation).toBeCalledTimes(1);
  });
});

describe('on subscription', () => {
  it('forwards subscriptions', () => {
    response = subscriptionResult;
    const [ops$, next, complete] = input;
    const exchange = cacheExchange(exchangeArgs)(ops$);

    publish(exchange);
    next(subscriptionOperation);
    next(subscriptionOperation);
    complete();
    expect(forwardedOperations.length).toBe(2);
    expect(reexecuteOperation).not.toBeCalled();
  });
});

// Empty query response implies the data propertys is undefined
describe('on empty query response', () => {
  beforeEach(() => {
    response = undefinedQueryResponse;
    forwardedOperations = [];
    reexecuteOperation = jest.fn();
    input = makeSubject<Operation>();

    // Collect all forwarded operations
    const forward = (s: Source<Operation>) => {
      return pipe(
        s,
        map(op => {
          forwardedOperations.push(op);
          return response;
        })
      );
    };

    const client = {
      reexecuteOperation: reexecuteOperation as any,
    } as Client;

    exchangeArgs = { forward, client };
  });

  it('does not cache response', () => {
    const [ops$, next, complete] = input;
    const exchange = cacheExchange(exchangeArgs)(ops$);

    publish(exchange);
    next(queryOperation);
    next(queryOperation);
    complete();
    // 2 indicates it's not cached.
    expect(forwardedOperations.length).toBe(2);
    expect(reexecuteOperation).not.toBeCalled();
  });
});

it('retriggers query operation when mutation occurs with union type', () => {
  const context: OperationContext = {
    fetchOptions: {
      method: 'POST',
    },
    requestPolicy: 'cache-first',
    url: 'http://localhost:3000/graphql',
  };

  const queryAllGql: GraphQLRequest = {
    key: 5,
    query: gql`
      query QueryLinks {
        links {
          type: __typename
          ... on LinkRecord {
            url
          }
          ... on DropdownLinkRecord {
            links {
              url
            }
          }
        }
      }
    `,
  };

  const teardownAllOperation: Operation = {
    query: queryAllGql.query,
    variables: queryAllGql.variables,
    key: queryAllGql.key,
    operationName: 'teardown',
    context,
  };

  const queryAllOperation: Operation = {
    query: teardownAllOperation.query,
    variables: teardownAllOperation.variables,
    key: teardownAllOperation.key,
    operationName: 'query',
    context,
  };

  response = {
    operation: queryAllOperation,
    data: {
      links: [
        {
          url: 'www.a.com',
          __typename: 'LinkRecord',
        },
        {
          url: 'www.b.com',
          __typename: 'LinkRecord',
        },
        // If the below section is uncommented, the test passes as expected
        // {
        //   links: [
        //     {
        //       url: 'www.d.com'
        //     },
        //   ],
        //   __typename: 'DropdownLinkRecord',
        // }
      ],
    },
  };

  const [ops$, next, complete] = input;
  const exchange = cacheExchange(exchangeArgs)(ops$);

  publish(exchange);
  next(queryAllOperation);

  const mutationAddLinkGql: GraphQLRequest = {
    key: 6,
    query: gql`
      mutation AddDropdownLink($link: DropdownLinkRecord!) {
        createDropdownLink(link: $link) {
          links {
            url
          }
        }
      }
    `,
    variables: {
      link: {
        links: [
          {
            url: 'www.c.com/1',
          },
          {
            url: 'www.c.com/2',
          },
        ],
      },
    },
  };

  const mutationAddLinkOperation: Operation = {
    query: mutationAddLinkGql.query,
    variables: mutationAddLinkGql.variables,
    key: mutationAddLinkGql.key,
    operationName: 'mutation',
    context,
  };

  response = {
    operation: mutationAddLinkOperation,
    data: {
      createDropdownLink: {
        links: [
          {
            url: 'www.c.com/1',
          },
          {
            url: 'www.c.com/2',
          },
        ],
        __typename: 'DropdownLinkRecord',
      },
    },
  };

  next(mutationAddLinkOperation);
  complete();

  // The original query should be re-executed to include the new DropdownLinkRecord result
  expect(reexecuteOperation).toBeCalledTimes(1);
});
