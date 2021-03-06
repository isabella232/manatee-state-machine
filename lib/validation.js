/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * validation.js: common functions for validating objects
 */

var mod_jsprim = require('jsprim');
var VError = require('verror');

var mod_lsn = require('pg-lsn');
var schemas = require('./schemas');


/*
 * Interface validators.  These validate the ZK and Postgres state reported to
 * us to make sure they look sane.  The current implementations copy the
 * incoming object, but it would be better if they actually filtered out fields
 * that were not present in the schema in order to enforce that new fields are
 * added to the schema.
 */
exports.validateZkState = validateZkState;
exports.validateZkPeers = validateZkPeers;
exports.validatePgStatus = validatePgStatus;
exports.validatePromoteRequest = validatePromoteRequest;

function validateZkState(clusterState)
{
	var copy, error;

	/*
	 * We want consumers to be able to assume that "deposed" is present, so
	 * it's required in the schema.  But we don't want a flag day for its
	 * introduction, so we insert it here (into our private copy).  Recall
	 * that the caller is supposed to use the value returned by this
	 * validator, not assume that just because we don't return an error that
	 * they can use the original copy.
	 */
	copy = mod_jsprim.deepCopy(clusterState);
	if (copy !== null && !copy.hasOwnProperty('deposed'))
		copy['deposed'] = [];

	error = mod_jsprim.validateJsonObject(schemas.zkState, copy);
	if (error instanceof Error)
		return (error);

	if (copy === null)
		return (null);

	if (copy.sync === null &&
	    (copy.oneNodeWriteMode === undefined ||
	    !copy.oneNodeWriteMode)) {
		return (new VError('"sync" may not be null outside of ' +
		    'one-node-write mode'));
	}

	error = mod_lsn.xlogValidate(clusterState.initWal);
	return (error instanceof Error ? error : copy);
}

function validateZkPeers(peers)
{
	return (validateAndCopy(schemas.zkPeers, peers));
}

function validatePgStatus(status)
{
	return (validateAndCopy(schemas.pgStatus, status));
}

function validateAndCopy(schema, obj)
{
	var error;
	error = mod_jsprim.validateJsonObject(schema, obj);
	if (error !== null)
		return (error);
	return (mod_jsprim.deepCopy(obj));
}

function validatePromoteRequest(clusterState)
{
	var promote, error, expireTime;
	promote = mod_jsprim.pluck(clusterState, 'promote');

	if (!promote)
		return (undefined);

	error = validateAndCopy(schemas.promote, promote);
	if (error instanceof Error)
		return (error);

	expireTime = mod_jsprim.parseDateTime(promote.expireTime);
	if (isNaN(expireTime.getTime())) {
		return (new VError('expireTime is not parseable (found "%s")',
		    promote.expireTime));
	}

	if (promote.generation !== clusterState.generation) {
		return (new VError('generation does not match (expected %d, ' +
		    'found %d)', clusterState.generation, promote.generation));
	}

	if (expireTime.getTime() < new Date().getTime())
		return (new VError('expireTime has passed ("%s")',
		    promote.expireTime));

	if (promote.role === 'async') {
		if (!promote.hasOwnProperty('asyncIndex')) {
			return (new VError(
			    'asyncIndex required but is missing'));
		}
		if (promote.asyncIndex < 0 ||
		    promote.asyncIndex >= clusterState.async.length) {
			return (new VError('asyncIndex is out of range'));
		}
		if (promote.id !== clusterState.async[promote.asyncIndex].id) {
			return (new VError('asyncIndex refers to wrong peer'));
		}
	} else {
		if (promote.id !== clusterState[promote.role].id) {
			return (new VError('id refers to peer in wrong role'));
		}
	}

	return (clusterState.promote);
}
