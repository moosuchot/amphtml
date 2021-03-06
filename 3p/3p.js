/**
 * Copyright 2015 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview Utility functions for scripts running inside of a third
 * party iframe.
 */

// Note: loaded by 3p system. Cannot rely on babel polyfills.


import {dev, user} from '../src/log';
import {isArray} from '../src/types';
import {rethrowAsync} from '../src/log';


/** @typedef {function(!Window, !Object)}  */
let ThirdPartyFunctionDef;


/**
 * @const {!Object<ThirdPartyFunctionDef>}
 * @visibleForTesting
 */
export const registrations = {};

/** @type {number} */
let syncScriptLoads = 0;

/**
 * @param {string} id The specific 3p integration.
 * @param {ThirdPartyFunctionDef} draw Function that draws the 3p integration.
 */
export function register(id, draw) {
  dev().assert(!registrations[id], 'Double registration %s', id);
  registrations[id] = draw;
}

/**
 * Execute the 3p integration with the given id.
 * @param {string} id
 * @param {!Window} win
 * @param {!Object} data
 */
export function run(id, win, data) {
  const fn = registrations[id];
  user().assert(fn, 'Unknown 3p: ' + id);
  fn(win, data);
}

/**
 * Synchronously load the given script URL. Only use this if you need a sync
 * load. Otherwise use {@link loadScript}.
 * Supports taking a callback that will be called synchronously after the given
 * script was executed.
 * @param {!Window} win
 * @param {string} url
 * @param {function()=} opt_cb
 */
export function writeScript(win, url, opt_cb) {
  /*eslint no-useless-concat: 0*/
  win.document
      .write('<' + 'script src="' + encodeURI(url) + '"><' + '/script>');
  if (opt_cb) {
    executeAfterWriteScript(win, opt_cb);
  }
}

/**
 * Asynchronously load the given script URL.
 * @param {!Window} win
 * @param {string} url
 * @param {function()=} opt_cb
 */
export function loadScript(win, url, opt_cb) {
  const s = win.document.createElement('script');
  s.src = url;
  if (opt_cb) {
    s.onload = opt_cb;
  }
  win.document.body.appendChild(s);
}

/**
 * Call function in micro task or timeout as a fallback.
 * This is a lightweight helper, because we cannot guarantee that
 * Promises are available inside the 3p frame.
 * @param {!Window} win
 * @param {function()} fn
 */
export function nextTick(win, fn) {
  const P = win.Promise;
  if (P) {
    P.resolve().then/*OK*/(fn);
  } else {
    win.setTimeout(fn, 0);
  }
}

/**
 * Run the function after all currently waiting sync scripts have been
 * executed.
 * @param {!Window} win
 * @param {function()} fn
 */
function executeAfterWriteScript(win, fn) {
  const index = syncScriptLoads++;
  win['__runScript' + index] = fn;
  win.document.write('<' + 'script>__runScript' + index + '()<' + '/script>');
}

/**
 * Throws if the given src doesn't start with prefix(es).
 * @param {!Array<string>|string} prefix
 * @param {string} src
 */
export function validateSrcPrefix(prefix, src) {
  if (!isArray(prefix)) {
    prefix = [prefix];
  }
  if (src !== undefined) {
    for (let p = 0; p <= prefix.length; p++) {
      const protocolIndex = src.indexOf(prefix[p]);
      if (protocolIndex == 0) {
        return;
      }
    }
  }
  throw new Error('Invalid src ' + src);
}

/**
 * Throws if the given src doesn't contain the string
 * @param {string} string
 * @param {string} src
 */
export function validateSrcContains(string, src) {
  if (src.indexOf(string) === -1) {
    throw new Error('Invalid src ' + src);
  }
}

/**
 * Throws a non-interrupting exception if data contains a field not supported
 * by this embed type.
 * @param {!Object} data
 * @param {!Array<string>} allowedFields
 */
export function checkData(data, allowedFields) {
  // Throw in a timeout, because we do not want to interrupt execution,
  // because that would make each removal an instant backward incompatible
  // change.
  try {
    validateData(data, allowedFields);
  } catch (e) {
    rethrowAsync(e);
  }
}

/**
 * Utility function to perform a potentially asynchronous task
 * exactly once for all frames of a given type and the provide the respective
 * value to all frames.
 * @param {!Window} global Your window
 * @param {string} taskId Must be not conflict with any other global variable
 *     you use. Must be the same for all callers from all frames that want
 *     the same result.
 * @param {function(function(*))} work Function implementing the work that
 *     is to be done. Receives a second function that should be called with
 *     the result when the work is done.
 * @param {function(*)} cb Callback function that is called when the work is
 *     done. The first argument is the result.
 */
export function computeInMasterFrame(global, taskId, work, cb) {
  const master = global.context.master;
  let tasks = master.__ampMasterTasks;
  if (!tasks) {
    tasks = master.__ampMasterTasks = {};
  }
  let cbs = tasks[taskId];
  if (!tasks[taskId]) {
    cbs = tasks[taskId] = [];
  }
  cbs.push(cb);
  if (!global.context.isMaster) {
    return;  // Only do work in master.
  }
  work(result => {
    for (let i = 0; i < cbs.length; i++) {
      cbs[i].call(null, result);
    }
    tasks[taskId] = {
      push: function(cb) {
        cb(result);
      },
    };
  });
}

/**
 * Throws an exception if data does not contains a mandatory field.
 * @param {!Object} data
 * @param {!Array<string>} mandatoryFields
 */
export function validateDataExists(data, mandatoryFields) {
  for (let i = 0; i < mandatoryFields.length; i++) {
    const field = mandatoryFields[i];
    user().assert(data[field],
        'Missing attribute for %s: %s.', data.type, field);
  }
}

/**
 * Throws an exception if data does not contains exactly one field
 * mentioned in the alternativeField array.
 * @param {!Object} data
 * @param {!Array<string>} alternativeFields
 */
export function validateExactlyOne(data, alternativeFields) {
  let countFileds = 0;

  for (let i = 0; i < alternativeFields.length; i++) {
    const field = alternativeFields[i];
    if (data[field]) {
      countFileds += 1;
    }
  }

  user().assert(countFileds === 1,
      '%s must contain exactly one of attributes: %s.',
      data.type,
      alternativeFields.join(', '));
}

/**
 * Throws an exception if data contains a field not supported
 * by this embed type.
 * @param {!Object} data
 * @param {!Array<string>} allowedFields
 */
export function validateData(data, allowedFields) {
  const defaultAvailableFields = {
    width: true,
    height: true,
    type: true,
    referrer: true,
    canonicalUrl: true,
    pageViewId: true,
    location: true,
    mode: true,
    consentNotificationId: true,
  };
  for (const field in data) {
    if (!data.hasOwnProperty(field) ||
        field in defaultAvailableFields) {
      continue;
    }
    user().assert(allowedFields.indexOf(field) != -1,
        'Unknown attribute for %s: %s.', data.type, field);
  }
}
