/*jslint bitwise: true, eqeqeq: true, immed: true, newcap: true, nomen: true, onevar: true, plusplus: true, regexp: true, undef: true, white: true, indent: 2 */
/*globals include md5 node exports */

process.mixin(require('./postgres-js/md5'));
var bits = require('./postgres-js/bits');
var tcp = require("tcp");
var sys = require("sys");

exports.DEBUG = 0;

// http://www.postgresql.org/docs/8.3/static/protocol-message-formats.html
var formatter = {
  CopyData: function () {
    // TODO: implement
  },
  CopyDone: function () {
    // TODO: implement
  },
  Describe: function (name, type) {
    return (new bits.Encoder('D'))
      .push_raw_string(type)
      .push_cstring(name);
  },
  Execute: function (name, max_rows) {
    return (new bits.Encoder('E'))
      .push_cstring(name)
      .push_int32(max_rows);
  },
  Flush: function () {
    return new bits.Encoder('H');
  },
  FunctionCall: function () {
    // TODO: implement
  },
  Parse: function (name, query, var_types) {
    var builder = (new bits.Encoder('P'))
      .push_cstring(name)
      .push_cstring(query)
      .push_int16(var_types.length);
    var_types.each(function (var_type) {
      builder.push_int32(var_type);
    });
    return builder;
  },
  PasswordMessage: function (password) {
    return (new bits.Encoder('p'))
      .push_cstring(password);
  },
  Query: function (query) {
    return (new bits.Encoder('Q'))
      .push_cstring(query);
  },
  SSLRequest: function () {
    return (new bits.Encoder())
      .push_int32(0x4D2162F);
  },
  StartupMessage: function (options) {
    // Protocol version number 3
    return (new bits.Encoder())
      .push_int32(0x30000)
      .push_hash(options);
  },
  Sync: function () {
    return new bits.Encoder('S');
  },
  Terminate: function () {
    return new bits.Encoder('X');
  }
};

// Parse response streams from the server
function parse_response(code, stream) {
  var input, type, args, num_fields, data, size, i;
  input = new bits.Decoder(stream);
  args = [];
  switch (code) {
  case 'R':
    switch (stream.shift_int32()) {
    case 0:
      type = "AuthenticationOk";
      break;
    case 2:
      type = "AuthenticationKerberosV5";
      break;
    case 3:
      type = "AuthenticationCleartextPassword";
      break;
    case 4:
      type = "AuthenticationCryptPassword";
      args = [stream.shift_raw_string(2)];
      break;
    case 5:
      type = "AuthenticationMD5Password";
      args = [stream.shift_raw_string(4)];
      break;
    case 6:
      type = "AuthenticationSCMCredential";
      break;
    case 7:
      type = "AuthenticationGSS";
      break;
    case 8:
      // TODO: add in AuthenticationGSSContinue
      type = "AuthenticationSSPI";
      break;
    }
    break;
  case 'E':
    type = "ErrorResponse";
    args = [{}];
    stream.shift_multi_cstring().forEach(function (field) {
      args[0][field[0]] = field.substr(1);
    });
    break;
  case 'S':
    type = "ParameterStatus";
    args = [stream.shift_cstring(), stream.shift_cstring()];
    break;
  case 'K':
    type = "BackendKeyData";
    args = [stream.shift_int32(), stream.shift_int32()];
    break;
  case 'Z':
    type = "ReadyForQuery";
    args = [stream.shift_raw_string(1)];
    break;
  case 'T':
    type = "RowDescription";
    num_fields = stream.shift_int16();
    data = [];
    for (i = 0; i < num_fields; i += 1) {
      data.push({
        field: stream.shift_cstring(),
        table_id: stream.shift_int32(),
        column_id: stream.shift_int16(),
        type_id: stream.shift_int32(),
        type_size: stream.shift_int16(),
        type_modifier: stream.shift_int32(),
        format_code: stream.shift_int16()
      });
    }
    args = [data];
    break;
  case 'D':
    type = "DataRow";
    data = [];
    num_fields = stream.shift_int16();
    for (i = 0; i < num_fields; i += 1) {
      size = stream.shift_int32();
      if (size === -1) {
        data.push(null);
      } else {
        data.push(stream.shift_raw_string(size));
      }
    }
    args = [data];
    break;
  case 'C':
    type = "CommandComplete";
    args = [stream.shift_cstring()];
    break;
  }
  if (!type) {
    sys.debug("Unknown response " + code);  
  }
  return {type: type, args: args};
}


exports.Connection = function (database, username, password, port, host) {
  var connection, events, query_queue, row_description, query_callback, results, readyState, closeState;
  
  // Default to port 5432
  port = port || 5432;

  // Default to host 127.0.0.1
  host = host || '127.0.0.1';

  connection = tcp.createConnection(port, host);

  // Disable the idle timeout on the connection
  connection.setTimeout(0);

  events = new process.EventEmitter();
  query_queue = [];
  readyState = false;
  closeState = false;

  // Sends a message to the postgres server
  function sendMessage(type, args) {
    var stream = (formatter[type].apply(this, args)).toString();
    if (exports.DEBUG > 0) {
      sys.debug("Sending " + type + ": " + JSON.stringify(args));
      if (exports.DEBUG > 2) {
        sys.debug("->" + JSON.stringify(stream));
      }
    }
    connection.send(stream, "binary");
  }
  
  // Set up tcp client
  connection.setEncoding("binary");
  connection.addListener("connect", function () {
    sendMessage('StartupMessage', [{user: username, database: database}]);
  });
  connection.addListener("receive", function (data) {
    var input, code, len, stream, command;
    input = new bits.Decoder(data);
    if (exports.DEBUG > 2) {
      sys.debug("<-" + JSON.stringify(data));
    }
  
    while (input.data.length > 0) {
      code = input.shift_code();
      len = input.shift_int32();
      stream = new bits.Decoder(input.shift_raw_string(len - 4));
      if (exports.DEBUG > 1) {
        sys.debug("stream: " + code + " " + JSON.stringify(stream));
      }
      command = parse_response(code, stream);
      if (command.type) {
        if (exports.DEBUG > 0) {
          sys.debug("Received " + command.type + ": " + JSON.stringify(command.args));
        }
        command.args.unshift(command.type);
        events.emit.apply(events, command.args);
      }
    }
  });
  connection.addListener("eof", function (data) {
    connection.close();
  });
  connection.addListener("disconnect", function (had_error) {
    if (had_error) {
      sys.debug("CONNECTION DIED WITH ERROR");
    }
  });

  // Set up callbacks to automatically do the login
  events.addListener('AuthenticationMD5Password', function (salt) {
    var result = "md5" + md5(md5(password + username) + salt);
    sendMessage('PasswordMessage', [result]);
  });
  events.addListener('AuthenticationCleartextPassword', function () {
    sendMessage('PasswordMessage', [password]);
  });
  events.addListener('ErrorResponse', function (e) {
    if (e.S === 'FATAL') {
      sys.debug(e.S + ": " + e.M);
      connection.close();
    }
  });
  events.addListener('ReadyForQuery', function () {
    if (query_queue.length > 0) {
      var query = query_queue.shift();
      query_callback = query.callback;
      sendMessage('Query', [query.sql]);
      readyState = false;
    } else {
      if (closeState) {
        connection.close();
      } else {
        readyState = true;      
      }
    }
  });
  events.addListener("RowDescription", function (data) {
    row_description = data;
    results = [];
  });
  events.addListener("DataRow", function (data) {
    var row, i, l, description, value;
    row = {};
    l = data.length;
    for (i = 0; i < l; i += 1) {
      description = row_description[i];
      value = data[i];
      if (value !== null) {
        // TODO: investigate to see if these numbers are stable across databases or
        // if we need to dynamically pull them from the pg_types table
        switch (description.type_id) {
        case 16: // bool
          value = value === 't';
          break;
        case 20: // int8
        case 21: // int2
        case 23: // int4
          value = parseInt(value, 10);
          break;
        }
      }
      row[description.field] = value;
    }
    results.push(row);
  });
  events.addListener('CommandComplete', function (data) {
    query_callback.call(this, results);
  });

  this.query = function (sql, callback) {
    query_queue.push({sql: sql, callback: callback});
    if (readyState) {
      events.emit('ReadyForQuery');
    }
  };
  this.close = function () {
    closeState = true;

    // Close the connection right away if there are no pending queries
    if (readyState) {
      connection.close();
    }
  };
};


