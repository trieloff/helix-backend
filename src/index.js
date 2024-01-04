/*
 * Copyright 2019 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import wrap from '@adobe/helix-shared-wrap';
import { logger } from '@adobe/helix-universal-logger';
import { helixStatus } from '@adobe/helix-status';
import { Response, Headers } from '@adobe/fetch';

/**
 * This is the main function
 * @param {Request} request the request object (see fetch api)
 * @param {UniversalContext} context the context of the universal serverless function
 * @returns {Response} a response
 */
async function run(request, context) {
  const owner = request.headers.get('x-owner');
  const site = request.headers.get('x-site') || request.headers.get('x-repo');
  const ref = request.headers.get('x-ref') || 'main';
  console.log(`owner: ${owner}, site: ${site}, ref: ${ref}`);
  if (!owner || !site) {
    return new Response('Missing x-owner or x-site header', {
      status: 400, headers: {
        'x-error': 'Missing x-owner or x-site header',
      }
    });
  }
  const url = new URL(request.url);
  const { pathname } = url;

  console.log('url', url, 'pathname', pathname);

  // check the config service if there is a known mountpoint for this site
  const configServiceURL = new URL(`https://helix-config.adobeioruntime.net/${ref}--${site}--${owner}/config.json`);

  console.log('configServiceURL', configServiceURL);

  const configServiceResponse = await fetch(configServiceURL, {
    backend: 'helix-config',
  });

  console.log('configServiceResponse', configServiceResponse.statusText);

  if (!configServiceResponse.ok) {
    return new Response('Bad Gateway', {
      status: 502, headers: {
        'x-error': 'Config service is not available',
      }
    });
  }

  const config = await configServiceResponse.json();

  console.log('config', JSON.stringify(config));

  const mountpoints = config.mountpoints || {};
  // look for a mountpoint that matches the request path
  const mountpoint = Object.keys(mountpoints).find((key) => {
    return pathname.startsWith(key);
  });
  if (!mountpoint) {
    return new Response('Not Found', {
      status: 404, headers: {
        'x-error': 'No mountpoint found',
      }
    });
  }
  console.log('mountpoint', mountpoint, 'backend', mountpoints[mountpoint]);
  // rewrite the request url to the backend
  const backendURL = new URL(mountpoints[mountpoint]);
  backendURL.pathname = pathname;
  backendURL.search = url.search;

  console.log('backendURL', backendURL);

  // cleanup the headers
  const headers = new Headers(request.headers);
  headers.delete('x-owner');
  headers.delete('x-site');
  headers.delete('x-ref');
  headers.delete('x-repo');
  headers.set('host', backendURL.hostname);

  let backend;
  if (context.runtime.name === 'compute-at-edge') {
    console.log('using compute-at-edge backend');
    // we need to jump through some extra hoops to support dynamic backends
    // as we are in isomorphic mode, we need to use dynamic imports to get
    // access to the dynamicBackends API
    const { allowDynamicBackends } = await import('fastly:experimental');
    const { Backend } = await import('fastly:backend');

    allowDynamicBackends(true);
    backend = new Backend({
      name: backendURL.hostname,
      target: backendURL.hostname,
      hostOverride: backendURL.hostname,
    });
  }

  console.log('ready to fetch', backendURL);

  // fetch the content from the backend
  return fetch(backendURL, {
    method: request.method,
    headers,
    body: request.body,
    backend,
  });
}

export const main = wrap(run)
  .with(helixStatus)
  .with(logger.trace)
  .with(logger);
