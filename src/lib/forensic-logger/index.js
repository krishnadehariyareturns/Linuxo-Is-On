'use strict';

const { createLogger } = require('./core/core');
const { Events } = require('./core/eventNames');
const levels = require('./core/levels');
const { buildLogComponent, toMessagePayload } = require('./core/components');

module.exports = {
    createLogger,
    Events,
    levels,
    buildLogComponent,
    toMessagePayload,
};
