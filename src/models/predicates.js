'use strict';

/**
 * All the predicates that determine whether a stub matches a request
 * @module
 */

const isNonNullObject = o => typeof o === 'object' && o !== null;

const sortObjects = (a, b) => {
    const stringify = require('json-stable-stringify');

    if (typeof a === 'object' && typeof b === 'object') {
        // Make best effort at sorting arrays of objects to make
        // deepEquals order-independent
        return sortObjects(stringify(a), stringify(b));
    }
    else if (a < b) {
        return -1;
    }
    else {
        return 1;
    }
};

const forceStrings = obj => {
    if (!isNonNullObject(obj)) {
        return obj;
    }
    else if (Array.isArray(obj)) {
        return obj.map(forceStrings);
    }
    else {
        return Object.keys(obj).reduce((result, key) => {
            if (Array.isArray(obj[key])) {
                result[key] = obj[key].map(forceStrings);
            }
            else if (obj[key] === null) {
                result[key] = 'null';
            }
            else if (isNonNullObject(obj[key])) {
                result[key] = forceStrings(obj[key]);
            }
            else if (['boolean', 'number'].indexOf(typeof obj[key]) >= 0) {
                result[key] = obj[key].toString();
            }
            else {
                result[key] = obj[key];
            }
            return result;
        }, {});
    }
};

const select = (type, selectFn, encoding) => {
    if (encoding === 'base64') {
        const errors = require('../util/errors');
        throw errors.ValidationError(`the ${type} predicate parameter is not allowed in binary mode`);
    }

    const nodeValues = selectFn();

    // Return either a string if one match or array if multiple
    // This matches the behavior of node's handling of query parameters,
    // which allows us to maintain the same semantics between deepEquals
    // (all have to match, passing in an array if necessary) and the other
    // predicates (any can match)
    if (nodeValues && nodeValues.length === 1) {
        return nodeValues[0];
    }
    else {
        return nodeValues;
    }
};

const orderIndependent = possibleArray => {
    const util = require('util');

    if (util.isArray(possibleArray)) {
        return possibleArray.sort(sortObjects);
    }
    else {
        return possibleArray;
    }
};

const transformObject = (obj, transform) => {
    Object.keys(obj).forEach(key => {
        obj[key] = transform(obj[key]);
    });
    return obj;
};

const selectXPath = (config, encoding, text) => {
    const xpath = require('./xpath'),
        combinators = require('../util/combinators'),
        selectFn = combinators.curry(xpath.select, config.selector, config.ns, text);

    return orderIndependent(select('xpath', selectFn, encoding));
};

const selectTransform = (config, options) => {
    const combinators = require('../util/combinators'),
        helpers = require('../util/helpers'),
        cloned = helpers.clone(config);

    if (config.jsonpath) {
        const stringTransform = options.shouldForceStrings ? forceStrings : combinators.identity;

        // use keyCaseSensitive instead of caseSensitive to help "matches" predicates too
        // see https://github.com/bbyars/mountebank/issues/361
        if (!cloned.keyCaseSensitive) {
            cloned.jsonpath.selector = cloned.jsonpath.selector.toLowerCase();
        }

        return combinators.curry(selectJSONPath, cloned.jsonpath, options.encoding, config, stringTransform);
    }
    else if (config.xpath) {
        if (!cloned.caseSensitive) {
            cloned.xpath.ns = transformObject(cloned.xpath.ns || {}, lowercase);
            cloned.xpath.selector = cloned.xpath.selector.toLowerCase();
        }
        return combinators.curry(selectXPath, cloned.xpath, options.encoding);
    }
    else {
        return combinators.identity;
    }
};

const lowercase = text => text.toLowerCase();

const caseTransform = config => {
    const combinators = require('../util/combinators');
    return config.caseSensitive ? combinators.identity : lowercase;
};

const exceptTransform = config => {
    const combinators = require('../util/combinators'),
        exceptRegexOptions = config.caseSensitive ? 'g' : 'gi';

    if (config.except) {
        return text => text.replace(new RegExp(config.except, exceptRegexOptions), '');
    }
    else {
        return combinators.identity;
    }
};

const encodingTransform = encoding => {
    const combinators = require('../util/combinators');
    if (encoding === 'base64') {
        return text => new Buffer(text, 'base64').toString();
    }
    else {
        return combinators.identity;
    }
};

const tryJSON = (value, predicateConfig) => {
    try {
        const keyCaseTransform = predicateConfig.keyCaseSensitive === false ? lowercase : caseTransform(predicateConfig),
            valueTransforms = [exceptTransform(predicateConfig), caseTransform(predicateConfig)];

        // We can't call normalize because we want to avoid the array sort transform,
        // which will mess up indexed selectors like $..title[1]
        return transformAll(JSON.parse(value), [keyCaseTransform], valueTransforms, []);
    }
    catch (e) {
        return value;
    }
};

const selectJSONPath = (config, encoding, predicateConfig, stringTransform, text) => {
    const jsonpath = require('./jsonpath'),
        combinators = require('../util/combinators'),
        possibleJSON = stringTransform(tryJSON(text, predicateConfig)),
        selectFn = combinators.curry(jsonpath.select, config.selector, possibleJSON);

    return orderIndependent(select('jsonpath', selectFn, encoding));
};

const transformAll = (obj, keyTransforms, valueTransforms, arrayTransforms) => {
    const combinators = require('../util/combinators'),
        apply = fns => combinators.compose.apply(null, fns);

    if (Array.isArray(obj)) {
        return apply(arrayTransforms)(obj.map(element => transformAll(element, keyTransforms, valueTransforms, arrayTransforms)));
    }
    else if (isNonNullObject(obj)) {
        return Object.keys(obj).reduce((result, key) => {
            result[apply(keyTransforms)(key)] = transformAll(obj[key], keyTransforms, valueTransforms, arrayTransforms);
            return result;
        }, {});
    }
    else if (typeof obj === 'string') {
        return apply(valueTransforms)(obj);
    }
    else {
        return obj;
    }
};

const normalize = (obj, config, options) => {
    // Needed to solve a tricky case conversion for "matches" predicates with jsonpath/xpath parameters
    if (typeof config.keyCaseSensitive === 'undefined') {
        config.keyCaseSensitive = config.caseSensitive;
    }

    const keyCaseTransform = config.keyCaseSensitive === false ? lowercase : caseTransform(config),
        sortTransform = array => array.sort(sortObjects),
        transforms = [];

    if (options.withSelectors) {
        transforms.push(selectTransform(config, options));
    }

    transforms.push(exceptTransform(config));
    transforms.push(caseTransform(config));
    transforms.push(encodingTransform(options.encoding));

    // sort to provide deterministic comparison for deepEquals,
    // where the order in the array for multi-valued querystring keys
    // and xpath selections isn't important
    return transformAll(obj, [keyCaseTransform], transforms, [sortTransform]);
};

const testPredicate = (expected, actual, predicateConfig, predicateFn) => {
    const helpers = require('../util/helpers');
    if (!helpers.defined(actual)) {
        actual = '';
    }
    if (isNonNullObject(expected)) {
        return predicateSatisfied(expected, actual, predicateConfig, predicateFn);
    }
    else {
        return predicateFn(expected, actual);
    }
};

const bothArrays = (expected, actual) => Array.isArray(actual) && Array.isArray(expected);

const allExpectedArrayValuesMatchActualArray = (expectedArray, actualArray, predicateConfig, predicateFn) =>
    expectedArray.every(expectedValue =>
        actualArray.some(actualValue => testPredicate(expectedValue, actualValue, predicateConfig, predicateFn)));

const onlyActualIsArray = (expected, actual) => Array.isArray(actual) && !Array.isArray(expected);

const expectedMatchesAtLeastOneValueInActualArray = (expected, actualArray, predicateConfig, predicateFn) => actualArray.some(actual => testPredicate(expected, actual, predicateConfig, predicateFn));

const expectedLeftOffArraySyntaxButActualIsArrayOfObjects = (expected, actual, fieldName) => {
    const helpers = require('../util/helpers');
    return !Array.isArray(expected[fieldName]) && !helpers.defined(actual[fieldName]) && Array.isArray(actual);
};

const predicateSatisfied = (expected, actual, predicateConfig, predicateFn) => {
    if (!actual) {
        return false;
    }

    // Support predicates that reach into fields encoded in JSON strings (e.g. HTTP bodies)
    if (typeof actual === 'string') {
        actual = tryJSON(actual, predicateConfig);
    }

    return Object.keys(expected).every(fieldName => {
        if (bothArrays(expected[fieldName], actual[fieldName])) {
            return allExpectedArrayValuesMatchActualArray(
                expected[fieldName], actual[fieldName], predicateConfig, predicateFn);
        }
        else if (onlyActualIsArray(expected[fieldName], actual[fieldName])) {
            if (predicateConfig.exists && expected[fieldName]) {
                return true;
            }
            else {
                return expectedMatchesAtLeastOneValueInActualArray(
                    expected[fieldName], actual[fieldName], predicateConfig, predicateFn);
            }
        }
        else if (expectedLeftOffArraySyntaxButActualIsArrayOfObjects(expected, actual, fieldName)) {
            // This is a little confusing, but predated the ability for users to specify an
            // array for the expected values and is left for backwards compatibility.
            // The predicate might be:
            //     { equals: { examples: { key: 'third' } } }
            // and the request might be
            //     { examples: '[{ "key": "first" }, { "different": true }, { "key": "third" }]' }
            // We expect that the "key" field in the predicate definition matches any object key
            // in the actual array
            return expectedMatchesAtLeastOneValueInActualArray(expected, actual, predicateConfig, predicateFn);
        }
        else if (isNonNullObject(expected[fieldName])) {
            return predicateSatisfied(expected[fieldName], actual[fieldName], predicateConfig, predicateFn);
        }
        else {
            return testPredicate(expected[fieldName], actual[fieldName], predicateConfig, predicateFn);
        }
    });
};

const create = (operator, predicateFn) => (predicate, request, encoding) => {
    const expected = normalize(predicate[operator], predicate, { encoding: encoding }),
        actual = normalize(request, predicate, { encoding: encoding, withSelectors: true });

    return predicateSatisfied(expected, actual, predicate, predicateFn);
};

const deepEquals = (predicate, request, encoding) => {
    const expected = normalize(forceStrings(predicate.deepEquals), predicate, { encoding: encoding }),
        actual = normalize(forceStrings(request), predicate, { encoding: encoding, withSelectors: true, shouldForceStrings: true }),
        stringify = require('json-stable-stringify');

    return Object.keys(expected).every(fieldName => {
        // Support predicates that reach into fields encoded in JSON strings (e.g. HTTP bodies)
        if (isNonNullObject(expected[fieldName]) && typeof actual[fieldName] === 'string') {
            const possibleJSON = tryJSON(actual[fieldName], predicate);
            actual[fieldName] = normalize(forceStrings(possibleJSON), predicate, { encoding: encoding });
        }
        return stringify(expected[fieldName]) === stringify(actual[fieldName]);
    });
};

const matches = (predicate, request, encoding) => {
    // We want to avoid the lowerCase transform on values so we don't accidentally butcher
    // a regular expression with upper case metacharacters like \W and \S
    // However, we need to maintain the case transform for keys like http header names (issue #169)
    // eslint-disable-next-line no-unneeded-ternary
    const caseSensitive = predicate.caseSensitive ? true : false, // convert to boolean even if undefined
        helpers = require('../util/helpers'),
        clone = helpers.merge(predicate, { caseSensitive: true, keyCaseSensitive: caseSensitive }),
        expected = normalize(predicate.matches, clone, { encoding: encoding }),
        actual = normalize(request, clone, { encoding: encoding, withSelectors: true }),
        options = caseSensitive ? '' : 'i',
        errors = require('../util/errors');

    if (encoding === 'base64') {
        throw errors.ValidationError('the matches predicate is not allowed in binary mode');
    }

    return predicateSatisfied(expected, actual, clone, (a, b) => new RegExp(a, options).test(b));
};

const not = (predicate, request, encoding, logger) => !evaluate(predicate.not, request, encoding, logger);

const evaluateFn = (request, encoding, logger) => subPredicate => evaluate(subPredicate, request, encoding, logger);

const or = (predicate, request, encoding, logger) => predicate.or.some(evaluateFn(request, encoding, logger));

const and = (predicate, request, encoding, logger) => predicate.and.every(evaluateFn(request, encoding, logger));

const inject = (predicate, request, encoding, logger, imposterState) => {
    const helpers = require('../util/helpers'),
        scope = helpers.clone(request),
        injected = `(${predicate.inject})(scope, logger, imposterState);`,
        errors = require('../util/errors');

    if (request.isDryRun === true) {
        return true;
    }

    try {
        return eval(injected);
    }
    catch (error) {
        logger.error(`injection X=> ${error}`);
        logger.error(`    source: ${JSON.stringify(injected)}`);
        logger.error(`    scope: ${JSON.stringify(scope)}`);
        logger.error(`    imposterState: ${JSON.stringify(imposterState)}`);
        throw errors.InjectionError('invalid predicate injection', { source: injected, data: error.message });
    }
};

const predicates = {
    equals: create('equals', (expected, actual) => expected === actual),
    deepEquals,
    contains: create('contains', (expected, actual) => actual.indexOf(expected) >= 0),
    startsWith: create('startsWith', (expected, actual) => actual.indexOf(expected) === 0),
    endsWith: create('endsWith', (expected, actual) => actual.indexOf(expected, actual.length - expected.length) >= 0),
    matches,
    exists: create('exists', (expected, actual) => expected ? (actual !== undefined && actual !== '') : (actual === undefined || actual === '')),
    not,
    or,
    and,
    inject
};

/**
 * Resolves all predicate keys in given predicate
 * @param {Object} predicate - The predicate configuration
 * @param {Object} request - The protocol request object
 * @param {string} encoding - utf8 or base64
 * @param {Object} logger - The logger, useful for debugging purposes
 * @param {Object} imposterState - The current state for the imposter
 * @returns {boolean}
 */
const evaluate = (predicate, request, encoding, logger, imposterState) => {
    const predicateFn = Object.keys(predicate).find(key => Object.keys(predicates).indexOf(key) >= 0),
        errors = require('../util/errors');

    if (predicateFn) {
        return predicates[predicateFn](predicate, request, encoding, logger, imposterState);
    }
    else {
        throw errors.ValidationError('missing predicate', { source: predicate });
    }
};

module.exports = { evaluate };
