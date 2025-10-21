/* eslint-disable no-restricted-globals */
import { Logger } from '@scaffoldly/rowdy';
import axios from 'axios';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { parse } from 'auth-header';
import { headers } from '../../src/aws/headers';

describe('aws headers', () => {
  const log = new Logger();

  const _it = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? it : it.skip;
  _it('should www authenticate to ECR properly', async () => {
    const sts = new STSClient({});
    const { Account } = await sts.send(new GetCallerIdentityCommand({}));
    const region = await sts.config.region();
    const registry = `${Account}.dkr.ecr.${region}.amazonaws.com`;

    const ecrUrl = new URL(`https://${registry}/v2/`);
    const response = await axios.get(ecrUrl.toString(), { validateStatus: () => true });
    expect(response.status).toBe(401);
    const wwwAuth = response.headers['www-authenticate'];
    expect(wwwAuth).toBeDefined();

    const { scheme, params } = parse(wwwAuth);
    expect(scheme).toBe('Basic');
    expect(params).toStrictEqual({ realm: `https://${registry}/`, service: 'ecr.amazonaws.com' });

    const _headers = await headers(log, scheme, new URL(params.realm!), params.service! as string);
    expect(_headers.intoJSON()).toHaveProperty('authorization');

    const authResponse = await axios.get(ecrUrl.toString(), {
      headers: _headers.intoAxios(),
    });
    expect(authResponse.status).toBe(200);
  });
});
