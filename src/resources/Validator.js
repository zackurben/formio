'use strict';

var Joi = require('joi');
var _ = require('lodash');
var vm = require('vm');
var util = require('../util/util');
var async = require('async');
var mongoose = require('mongoose');
var debug = require('debug')('formio:validator');

/**
 * @TODO: Add description.
 *
 * @param form
 * @param model
 * @constructor
 */
var Validator = function(form, model) {
  this.customValidations = {};
  this.schema = null;
  this.model = model;
  this.unique = {};

  // Flatten the components array.
  var components = util.flattenComponents(form.components);

  // Build the Joi validation schema.
  var keys = {
    // Start off with the _id key.
    _id: Joi.string().meta({primaryKey: true})
  };

  // Iterate through each component.
  _.each(components, function(component) {
    var fieldValidator = null;
    if (!component) { return; }

    // If the value must be unique.
    if (component.unique) {
      this.unique[component.key] = component;
    }

    // Add the custom validations.
    if (component.validate && component.validate.custom) {
      this.customValidations[component.key] = component;
    }

    switch (component.type) {
      case 'textfield':
      case 'textarea':
      case 'phonenumber':
        fieldValidator = Joi.string().empty('');
        if (component.validate && component.validate.minLength && (typeof component.validate.minLength === 'number')) {
          fieldValidator = fieldValidator.min(component.validate.minLength);
        }
        if (component.validate && component.validate.maxLength && (typeof component.validate.maxLength === 'number')) {
          fieldValidator = fieldValidator.max(component.validate.maxLength);
        }
        break;
      case 'email':
        fieldValidator = Joi.string().email().empty('');
        break;
      case 'number':
        fieldValidator = Joi.number().empty(null);
        if (component.validate) {

          // If the step is provided... we can infer float vs. integer.
          if (component.validate.step && (typeof component.validate.step !== 'any')) {
            var parts = component.validate.step.split('.');
            if (parts.length === 1) {
              fieldValidator = fieldValidator.integer();
            }
            else {
              fieldValidator = fieldValidator.precision(parts[1].length);
            }
          }

          _.each(['min', 'max', 'greater', 'less'], function (check) {
            if (component.validate[check] && (typeof component.validate[check] === 'number')) {
              fieldValidator = fieldValidator[check](component.validate[check]);
            }
          });
        }
        break;
      default:
        fieldValidator = Joi.any();
        break;
    }

    // Only run validations for persistent fields with values but not on embedded.
    if (component.key && (component.key.indexOf('.') === -1) && component.persistent && component.validate) {
      // Add required validator.
      if (component.validate.required) {
        fieldValidator = fieldValidator.required().empty();
      }

      // Add regex validator
      if (component.validate.pattern) {
        var regex = new RegExp(component.validate.pattern);
        fieldValidator = fieldValidator.regex(regex);
      }
    }

    // Make sure to change this to an array if multiple is checked.
    if (component.multiple) {
      fieldValidator = Joi.array().sparse().items(fieldValidator);
    }

    // Create the validator.
    if (fieldValidator) {
      keys[component.key] = fieldValidator;
    }
  }.bind(this));

  // Create the validator schema.
  this.schema = Joi.object().keys(keys);
};

/**
 * Validate a submission for a form.
 *
 * @param submissionData
 * @param submissionRequest
 * @param next
 * @returns {*}
 */
Validator.prototype.validate = function(submissionData, submissionRequest, next) {
  var valid = true;
  var error = null;

  /**
   * Invoke the Joi validator with our data.
   *
   * @type {function(this:Validator)}
   */
  var joiValidate = function() {
    Joi.validate(submissionData, this.schema, {stripUnknown: true}, function(validateErr, value) {
      if (validateErr) {
        debug(validateErr);
        return next(validateErr);
      }

      next(null, value);
    });
  }.bind(this);

  // Check for custom validations.
  for (var key in this.customValidations) {
    // If there is a value for this submission....
    if (this.customValidations.hasOwnProperty(key) && (submissionData[key] !== undefined)) {
      var component = this.customValidations[key];

      // Try a new sandboxed validation.
      try {
        // Replace with variable substitutions.
        component.validate.custom = component.validate.custom.replace(/({{\s+(.*)\s+}})/, function(match, $1, $2) {
          return submissionRequest.data[$2];
        });

        // Create the sandbox.
        var sandbox = vm.createContext({
          input: submissionRequest.data[key],
          component: component,
          valid: valid
        });

        // Execute the script.
        var script = new vm.Script(component.validate.custom);
        script.runInContext(sandbox);
        valid = sandbox.valid;
      }
      catch (err) {
        // Say this isn't valid based on bad code executed...
        valid = err.toString();
      }

      // If there is an error, then set the error object and break from iterations.
      if (valid !== true) {
        error = {
          message: valid,
          path: key,
          type: component.type + '.custom'
        };
        break;
      }
    }
  }

  // If an error has occured in custom validation, fail immediately.
  if (error) {
    var temp = {name: 'ValidationError', details: [error]};
    debug(error);
    return next(temp);
  }

  // Iterate through each of the unique keys.
  var uniques = _.keys(this.unique);
  if (uniques.length > 0) {
    async.eachSeries(uniques, function(key, done) {
      var component = this.unique[key];

      // Unique fields must always be set with a value.
      debug('Key: ' + key);
      if (
        !submissionData.hasOwnProperty(key) &&
        !submissionData[key]
      ) {
        // Throw an error if this isn't a resource field.
        if (key.indexOf('.') === -1) {
          debug('Unique field: ' + key + ', was not a resource field.');
          return done(new Error('Unique fields cannot be empty.'));
        }
        else {
          return done();
        }
      }

      // Get the query.
      var query = {form: mongoose.Types.ObjectId(submissionRequest.form)};
      query['data.' + key] = submissionData[key];

      // Only search for non-deleted items.
      if (!query.hasOwnProperty('deleted')) {
        query['deleted'] = {$eq: null};
      }

      // Try to find an existing value within the form.
      debug(query);
      this.model.findOne(query, function(err, result) {
        if (err) {
          debug(err);
          return done(err);
        }
        if (result && submissionRequest._id && (result._id.toString() === submissionRequest._id)) {
          return done();
        }
        if (result) {
          return done(new Error(component.label + ' must be unique.'));
        }

        done();
      });
    }.bind(this), function(err) {
      if (err) {
        return next(err.message);
      }

      joiValidate();
    });
  }
  else {
    joiValidate();
  }
};

module.exports = Validator;
