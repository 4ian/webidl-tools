'use strict';

var log = require('./util').log;
var util = require('./util');
var webidl2 = require('webidl2');
var write = require('webidl2/lib/writer').write;

/**
 * Add command-line options for the WebIDL options.
 * @param {object} program
 * @param {number} offset
 * @param {number} width
 * @param {?object} [options={}]
 * @returns {object}
 */
function addOptions(program, o, w, options) {
  function parseReplacement(str, memo) {
    var match = str.match(/^s?\/?([^/]*)\/([^/]*)\/?$/);
    if (!match) {
      throw new Error('Unable to parse regular expression');
    }
    var regex = new RegExp(match[1]);
    var replacement = match[2];
    memo.push([regex, replacement]);
    return memo;
  }

  function parseRegex(str, memo) {
    var match = str.match(/^\/?(.*)\/?$/);
    if (!match) {
      throw new Error('Unable to parse regular expression');
    }
    var regex = new RegExp(match[1]);
    memo.push(regex);
    return memo;
  }

  options = options || {};

  return program
    .option('--module-name <name>', util.wrap(
      'If specified, create a module with this name containing all interfaces.', o, w))
    .option('--prefix-interfaces <prefix>', util.wrap(
      'Add the specified prefix to the interfaces', o, w))
    .option('--static-operation-prefix <prefix>', util.wrap(
      'The prefix to remove from operations, which then must be considered as static', o, w))
    .option('--add-delete-operation', util.wrap(
      'Add a "delete" method to all the interfaces', o, w))
    .option('--add-emscripten-ptr-attribute', util.wrap(
      'Add a "ptr" number attribute to all the interfaces', o, w))
    .option('--uncapitalize-operations', util.wrap(
      'Uncapitalize the operations (methods) of interfaces', o, w))
    .option('--rename <s/foo/bar/>', util.wrap(
      'Rename WebIDL interface, argument, etc., names ' +
      '(can be specified multiple times; applied after --skip)', o, w),
      parseReplacement, [])
    .option('--only </foo/>', util.wrap(
      'Only process WebIDL definitions with the given name ' +
      '(can be specified multiple times)', o, w),
      parseRegex, [])
    .option('--skip </foo/>', util.wrap(
      'Skip WebIDL definitions with the given name ' +
      '(can be specified multiple times; applied after --only)', o, w),
      parseRegex, [])
    .option('-b, --bail', util.wrap(
      'Exit on WebIDL parse failure', o, w))
    .option('--merge', util.wrap(
      'Merge WebIDL definitions by unioning interface and dictionary members' +
      (options.merge ? ' (default)' : ''), o, w),
      options.merge)
    .option('--no-merge', util.wrap(
      'Don\'t merge WebIDL definitions; if a merge is required and this ' +
      'option is specified, the process exits', o, w));
}

exports.addOptions = addOptions;

function capitalize(str) {
  if (!str) return '';
  return str[0].toUpperCase() + str.substr(1);
}

function uncapitalize(str) {
  if (!str) return '';
  return str[0].toLowerCase() + str.substr(1);
}

/**
 * Extract definitions by name from a File.
 * @param {File|string} file - the file to extract from
 * @param {object} options
 * @returns {Map<string, Array<object>>}
 */
function extractDefinitions(file, options) {
  var definitions;
  var definitionsByName = new Map();
  var unparsed;

  if (typeof file === 'object') {
    log.debug('Extracting definitions from %s', file.path);
    unparsed = file.contents.toString();
  } else {
    unparsed = file;
  }

  try {
    definitions = parse(unparsed);
  } catch (error) {
    log[options.bail ? 'error' : 'warn'](
      'Unable to parse WebIDL\n%s\n%s\n%s\n%s', util.hline, unparsed,
      util.hline, error.toString());
    if (options.bail) {
      process.exit(1);
    }
    return definitionsByName;
  }

  const prefixedDefinitionNames = new Map();
  const getPrefixedName = (name) => {
    return prefixedDefinitionNames.get(name) || name;
  }

  if (options.prefixInterfaces) {
    const prefix = options.prefixInterfaces;
    definitions.forEach((definition) => {
      if (definition.type === 'interface') {
        const prefixedName = definition.name.indexOf(prefix) === 0 ? definition.name :
          prefix + capitalize(definition.name);
        prefixedDefinitionNames.set(definition.name, prefixedName);
      }
    });
  }

  // Add inheritance on interfaces targeted by an "implements" definition.
  definitions.forEach((definition) => {
    if (definition.type === 'implements') {
      const implementsName = definition.target;
      const targetDefinition = definitions.find(definition => definition.name === implementsName);

      if (targetDefinition) {
        targetDefinition.inheritance = definition.implements;
      }
    }
  });

  // Generate a class with all the interfaces.
  if (options.moduleName) {
    const moduleDefinitionName = options.moduleName;
    const moduleDefinition = {
      "type":"interface",
      "name":moduleDefinitionName,
      "members":[],

    }
    definitions.forEach((definition) => {
      if (definition.type !== 'interface' && definition.type !== 'enum') return;

      moduleDefinition.members.push({
        "type":"attribute",
        "static":false,
        "stringifier":false,
        "inherit":false,
        "readonly":false,
        "idlType":{"sequence":false,"generic":"Class","nullable":false,"array":false,"union":false,"idlType": getPrefixedName(definition.name)},
        "name":definition.name,
        "extAttrs":[]
      });
    });
    definitionsByName.set(moduleDefinitionName, moduleDefinition);
  }

  definitions.forEach((definition) => {
    var name = definition.name;
    log.debug('Parsed WebIDL for %s', name);
    // log.debug('Parsed WebIDL for %s\n%s\n%s\n%s', name, util.hline,
    //   write([definition]), util.hline);

    if (options.only.length) {
      for (var regex of options.only) {
        if (!name.match(regex)) {
          log.debug('Skipping %s', name);
          return;
        }
      }
    }

    for (var regex of options.skip) {
      if (name.match(regex)) {
        log.debug('Skipping %s', name);
        return;
      }
    }

    for (var pair of options.rename) {
      definition = replace(pair[0], pair[1], definition);
    }

    if (definition.members) {
      definition.members.forEach((member) => {
        if (member.type === 'operation') {
          if (member.name === definition.name) {
            // Constructor.
            member.name = 'constructor';
          } else {
            if (options.staticOperationPrefix) {
              const staticPrefix = options.staticOperationPrefix;
              if (member.name.indexOf(staticPrefix) === 0) {
                member.name = member.name.substr(staticPrefix.length);
                member.static = true;
              }
            }
            if (options.uncapitalizeOperations) {
              member.name = uncapitalize(member.name);
            }
          }

          // Adapt arguments
          member.arguments.forEach(argument => {
            if (argument.idlType && typeof argument.idlType.idlType === 'string') {
              if (prefixedDefinitionNames.has(argument.idlType.idlType)) {
                argument.idlType.idlType = getPrefixedName(argument.idlType.idlType);
              }
            }
          });

          // Adapt return type
          if (member.idlType && typeof member.idlType.idlType === 'string') {
            if (prefixedDefinitionNames.has(member.idlType.idlType)) {
              member.idlType.idlType = getPrefixedName(member.idlType.idlType);
            }
          }
        } else if (member.type === 'attribute') {
          // Attribute. Do nothing.
        }
      })
    }
    // Adapt name
    if (definition.type === 'interface') {
      definition.name = getPrefixedName(definition.name);
    }
    // Adapt inheritance
    if (definition.inheritance) {
      definition.inheritance = getPrefixedName(definition.inheritance);
    }

    if (options.addDeleteOperation) {
      if (definition.members) {
        definition.members.push({
          "type":"operation",
          "getter":false,
          "setter":false,
          "creator":false,
          "deleter":false,
          "legacycaller":false,
          "static":false,
          "stringifier":false,
          "idlType":{"sequence":false,"generic":null,"nullable":false,"array":false,"union":false,"idlType":"void"},
          "name":"delete",
          "arguments":[],
          "extAttrs":[]
        });
      }
    }

    if (options.addEmscriptenPtrAttribute) {
      if (definition.members) {
        definition.members.push({
          "type":"attribute",
          "static":false,
          "stringifier":false,
          "inherit":false,
          "readonly":false,
          "idlType":{"sequence":false,"generic":null,"nullable":false,"array":false,"union":false,"idlType":"number"},
          "name":"ptr",
          "extAttrs":[]
        });
      }
    }

    name = definition.name;
    if (name) {
      if (!definitionsByName.has(name)) {
        definitionsByName.set(name, []);
      }

      definitionsByName.get(name).push(definition);
    }
  });

  return definitionsByName;
}

exports.extractDefinitions = extractDefinitions;

/**
 * Merge partial definitions, dictionaries, etc. Method return and parameter
 * types will be merged into unions.
 * @param {Map<string, Array<object>>} definitionsByName
 * @param {object} options
 * @returns {Array<object>}
 */
function mergeDefinitionsByName(definitionsByName, options) {
  return Array.from(definitionsByName.values()).map(definitions => {
    if (definitions.length > 1 && !options.merge) {
      log.error('There are %s definitions for %s that would be merged',
        definitions.length, definitions[0].name);
      process.exit(1);
    }
    return definitions.reduce((mergedDefinition, definition) => {
      if (mergedDefinition.members && definition.members) {
        mergedDefinition.members = mergedDefinition.members.concat(
          definition.members);
      }
      if (mergedDefinition.values && definition.values) {
        mergedDefinition.values = mergedDefinition.values.concat(
          definition.values);
      }
      return mergedDefinition;
    });
  });
}

exports.mergeDefinitionsByName = mergeDefinitionsByName;

/**
 * Replace names in a definition.
 * @param {RegEx} match
 * @param {string} replace
 * @param {object} definition
 * @returns {object}
 */
function replace(match, replacement, definition) {
  if (definition.generic) {
    definition.generic = definition.generic.replace(match, replacement);
  }
  if (definition.idlType) {
    if (typeof definition.idlType === 'string') {
      definition.idlType = definition.idlType.replace(match, replacement);
    } else if (definition.idlType instanceof Array) {
      definition.idlType = definition.idlType.map(idlType => {
        return replace(match, replacement, idlType);
      });
    } else {
      definition.idlType = replace(match, replacement, definition.idlType);
    }
  }
  if (definition.name) {
    definition.name = definition.name.replace(match, replacement);
  }
  if (definition.members) {
    definition.members = definition.members.map(member => {
      return replace(match, replacement, member);
    });
  }
  if (definition.inheritance) {
    definition.inheritance = definition.inheritance.replace(match, replacement);
  }
  if (definition.arguments) {
    definition.arguments = definition.arguments.map(argument => {
      return replace(match, replacement, argument);
    });
  }
  if (definition.default) {
    definition.default = replace(match, replacement, definition.default);
  }
  if (definition.target) {
    definition.target = definition.target.replace(match, replacement);
  }
  if (definition.implements) {
    definition.implements = definition.implements.replace(match, replacement);
  }
  if (definition.iteratorObject) {
    definition.iteratorObject =
      definition.iteratorObject.replace(match, replacement);
  }
  if (definition.extAttrs) {
    definition.extAttrs = definition.extAttrs.map(extAttr => {
      return replace(match, replacement, extAttr);
    });
  }
  if (definition.typeExtAttrs) {
    definition.typeExtAttrs = definition.typeExtAttrs.map(typeExtAttr => {
      return replace(match, replacement, typeExtAttr);
    });
  }
  return definition;
}

exports.replace = replace;

var parse = webidl2.parse;

exports.parse = parse;

exports.write = write;
