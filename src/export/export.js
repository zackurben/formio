'use strict';

var util = require('../util/util');
var exporters = require('./index');
var _ = require('lodash');
var mongoose = require('mongoose');
var through = require('through');
var node_url = require('url');

module.exports = function(router) {
  var hook = require('../util/hook')(router.formio);

  // Mount the export endpoint using the url.
  router.get('/form/:formId/export', function(req, res, next) {
    // Get the export format.
    var format = (req.query && req.query.format)
      ? req.query.format
      : 'json';

    // Handle unknown formats.
    if (!exporters.hasOwnProperty(format)) {
      return res.status(500).send('Unknown format');
    }

    // Load the form.
    router.formio.cache.loadCurrentForm(req, function(err, form) {
      if (err) {
        return res.sendStatus(401);
      }
      if (!form) {
        return res.sendStatus(404);
      }

      // Allow them to provide a query.
      var query = {};
      if (req.headers.hasOwnProperty('x-query')) {
        try {
          query = JSON.parse(req.headers['x-query']);
        }
        catch (e) {
          console.log(e);
        }
      }

      // Enforce the form.
      query.form = form._id;

      // Only show non-deleted items unless specified
      if (query && !query.hasOwnProperty('deleted')) {
        query.deleted = {$eq: null};
      }

      // Create the exporter.
      var exporter = new exporters[format](form, req, res);

      // Initialize the exporter.
      exporter.init()
        .then(function() {
          var addUrl = function(data) {
            _.each(data, function(field) {
              if(field._id) {
                // Add url property for resource fields
                var fieldUrl = hook.alter('fieldUrl', '/form/' + field.form + '/submission/' + field._id, form, field);
                field.url = node_url.resolve(router.formio.config.apiHost, fieldUrl);
                // Recurse for nested resources
                addUrl(field.data);
              }
            });
          };
          // Create the query stream.
          var stream = router.formio.resources.submission.model.find(query).select({__v: 0, deleted: 0}).stream()
          .pipe(through(function(doc) {
            var row = doc.toObject({getters:true, virtuals:false});
            addUrl(row.data);
            this.queue(row);
          }));


          // Create the stream.
          exporter.stream(stream).pipe(res);
        })
        .catch(function (error) {
          // Send the error.
          res.status(500).send(error);
        });
    });
  });
};
