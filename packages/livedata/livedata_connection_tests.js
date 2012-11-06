var newConnection = function (stream) {
  // Some of these tests leave outstanding methods with no result yet
  // returned. This should not block us from re-running tests when sources
  // change.
  return new Meteor._LivedataConnection(stream, {reloadWithOutstanding: true});
};

var test_got_message = function (test, stream, expected) {
  if (stream.sent.length === 0) {
    test.fail({error: 'no message received', expected: expected});
    return;
  }

  var got = stream.sent.shift();

  if (typeof got === 'string' && typeof expected === 'object')
    got = JSON.parse(got);

  test.equal(got, expected);
};

var startAndConnect = function(test, stream) {
  stream.reset(); // initial connection start.

  test_got_message(test, stream, {msg: 'connect'});
  test.length(stream.sent, 0);

  stream.receive({msg: 'connected', session: SESSION_ID});
  test.length(stream.sent, 0);
};

var SESSION_ID = '17';

Tinytest.add("livedata stub - receive data", function (test) {
  var stream = new Meteor._StubStream();
  var conn = newConnection(stream);

  startAndConnect(test, stream);

  // data comes in for unknown collection.
  var coll_name = Meteor.uuid();
  stream.receive({msg: 'data', collection: coll_name, id: '1234',
                  set: {a: 1}});
  // break throught the black box and test internal state
  test.length(conn._updatesForUnknownStores[coll_name], 1);

  // XXX: Test that the old signature of passing manager directly instead of in
  // options works.
  var coll = new Meteor.Collection(coll_name, conn);

  // queue has been emptied and doc is in db.
  test.isUndefined(conn._updatesForUnknownStores[coll_name]);
  test.equal(coll.find({}).fetch(), [{_id:'1234', a:1}]);

  // second message. applied directly to the db.
  stream.receive({msg: 'data', collection: coll_name, id: '1234',
                  set: {a:2}});
  test.equal(coll.find({}).fetch(), [{_id:'1234', a:2}]);
  test.isUndefined(conn._updatesForUnknownStores[coll_name]);
});

Tinytest.addAsync("livedata stub - subscribe", function (test, onComplete) {
  var stream = new Meteor._StubStream();
  var conn = newConnection(stream);

  startAndConnect(test, stream);

  // subscribe
  var callback_fired = false;
  var sub = conn.subscribe('my_data', function () {
    callback_fired = true;
  });
  test.isFalse(callback_fired);

  test.length(stream.sent, 1);
  var message = JSON.parse(stream.sent.shift());
  var id = message.id;
  delete message.id;
  test.equal(message, {msg: 'sub', name: 'my_data', params: []});

  // get the sub satisfied. callback fires.
  stream.receive({msg: 'data', 'subs': [id]});
  test.isTrue(callback_fired);

  // This defers the actual unsub message, so we need to set a timeout
  // to observe the message. We also test that we can resubscribe even
  // before the unsub has been sent.
  //
  // Note: it would be perfectly fine for livedata_connection to send the unsub
  // synchronously, so if this test fails just because we've made that change,
  // that's OK! This is a regression test for a failure case where it *never*
  // sent the unsub if there was a quick resub afterwards.
  //
  // XXX rewrite Meteor.defer to guarantee ordered execution so we don't have to
  // use setTimeout
  sub.stop();
  conn.subscribe('my_data');

  test.length(stream.sent, 1);
  message = JSON.parse(stream.sent.shift());
  var id2 = message.id;
  test.notEqual(id, id2);
  delete message.id;
  test.equal(message, {msg: 'sub', name: 'my_data', params: []});

  setTimeout(function() {
    test.length(stream.sent, 1);
    var message = JSON.parse(stream.sent.shift());
    test.equal(message, {msg: 'unsub', id: id});
    onComplete();
  }, 10);
});


Tinytest.add("livedata stub - this", function (test) {
  var stream = new Meteor._StubStream();
  var conn = newConnection(stream);

  startAndConnect(test, stream);

  conn.methods({test_this: function() {
    test.isTrue(this.isSimulation);
    // XXX Backwards compatibility only. Remove this before 1.0.
    test.isTrue(this.is_simulation);
    this.unblock(); // should be a no-op
  }});

  // should throw no exceptions
  conn.call('test_this');

  // satisfy method, quiesce connection
  var message = JSON.parse(stream.sent.shift());
  test.equal(message, {msg: 'method', method: 'test_this',
                       params: [], id:message.id});
  test.length(stream.sent, 0);

  stream.receive({msg: 'result', id:message.id, result:null});
  stream.receive({msg: 'data', 'methods': [message.id]});

});


Tinytest.add("livedata stub - methods", function (test) {
  var stream = new Meteor._StubStream();
  var conn = newConnection(stream);

  startAndConnect(test, stream);

  var coll_name = Meteor.uuid();
  var coll = new Meteor.Collection(coll_name, {manager: conn});

  // setup method
  conn.methods({do_something: function (x) {
    coll.insert({value: x});
  }});

  // setup observers
  var counts = {added: 0, removed: 0, changed: 0, moved: 0};
  var handle = coll.find({}).observe(
    { added: function () { counts.added += 1; },
      removed: function () { counts.removed += 1; },
      changed: function () { counts.changed += 1; },
      moved: function () { counts.moved += 1; }
    });


  // call method with results callback
  var callback_fired = false;
  conn.call('do_something', 'friday!', function (err, res) {
    test.isUndefined(err);
    test.equal(res, '1234');
    callback_fired = true;
  });
  test.isFalse(callback_fired);

  // observers saw the method run.
  test.equal(counts, {added: 1, removed: 0, changed: 0, moved: 0});

  // get response from server
  var message = JSON.parse(stream.sent.shift());
  test.equal(message, {msg: 'method', method: 'do_something',
                       params: ['friday!'], id:message.id});

  test.equal(coll.find({}).count(), 1);
  test.equal(coll.find({value: 'friday!'}).count(), 1);
  var docId = coll.findOne({value: 'friday!'})._id;

  // results result in callback
  stream.receive({msg: 'result', id:message.id, result:"1234"});
  test.isTrue(callback_fired);  // XXX this test will change

  // result callback doesn't affect data
  test.equal(coll.find({}).count(), 1);
  test.equal(coll.find({value: 'friday!'}).count(), 1);
  test.equal(counts, {added: 1, removed: 0, changed: 0, moved: 0});

  // data methods do not show up (not quiescent yet)
  stream.receive({msg: 'data', collection: coll_name, id: docId,
                  set: {value: 'tuesday'}});
  test.equal(coll.find({}).count(), 1);
  test.equal(coll.find({value: 'friday!'}).count(), 1);
  test.equal(counts, {added: 1, removed: 0, changed: 0, moved: 0});

  // send another methods (unknown on client)
  callback_fired = false;
  conn.call('do_something_else', 'monday', function (err, res) {
    callback_fired = true;
  });
  test.isFalse(callback_fired);

  // test we still send a method request to server
  var message_2 = JSON.parse(stream.sent.shift());
  test.equal(message_2, {msg: 'method', method: 'do_something_else',
                         params: ['monday'], id:message_2.id});

  // get the first data satisfied message. changes are applied to database even
  // though another method is outstand, because the other method didn't have a
  // stub.
  stream.receive({msg: 'data', 'methods': [message.id]});

  test.equal(coll.find({}).count(), 1);
  test.equal(coll.find({value: 'tuesday'}).count(), 1);
  test.equal(counts, {added: 1, removed: 0, changed: 1, moved: 0});

  // second result
  test.isFalse(callback_fired);
  stream.receive({msg: 'result', id:message_2.id, result:"bupkis"});
  test.isTrue(callback_fired);

  // get second satisfied; no new changes are applied.
  stream.receive({msg: 'data', 'methods': [message_2.id]});

  test.equal(coll.find({}).count(), 1);
  test.equal(coll.find({value: 'tuesday', _id: docId}).count(), 1);
  test.equal(counts, {added: 1, removed: 0, changed: 1, moved: 0});

  handle.stop();
});


// method calls another method in simulation. see not sent.
Tinytest.add("livedata stub - methods calling methods", function (test) {
  var stream = new Meteor._StubStream();
  var conn = newConnection(stream);

  startAndConnect(test, stream);

  var coll_name = Meteor.uuid();
  var coll = new Meteor.Collection(coll_name, {manager: conn});

  // setup methods
  conn.methods({
    do_something: function () {
      conn.call('do_something_else');
    },
    do_something_else: function () {
      coll.insert({a: 1});
    }
  });

  // setup observers
  var counts = {added: 0, removed: 0, changed: 0, moved: 0};
  var handle = coll.find({}).observe(
    { added: function () { counts.added += 1; },
      removed: function () { counts.removed += 1; },
      changed: function () { counts.changed += 1; },
      moved: function () { counts.moved += 1; }
    });


  // call method.
  conn.call('do_something');

  // see we only send message for outer methods
  var message = JSON.parse(stream.sent.shift());
  test.equal(message, {msg: 'method', method: 'do_something',
                       params: [], id:message.id});
  test.length(stream.sent, 0);

  // but inner method runs locally.
  test.equal(counts, {added: 1, removed: 0, changed: 0, moved: 0});
  test.equal(coll.find().count(), 1);
  var docId = coll.findOne()._id;
  test.equal(coll.findOne(), {_id: docId, a: 1});

  // we get the results (this is important to make the test not block
  // auto-reload!)
  stream.receive({msg: 'result', id:message.id, result:"1234"});

  // get data from the method. data from this doc does not show up yet, but data
  // from another doc does.
  stream.receive({msg: 'data', collection: coll_name, id: docId,
                  set: {value: 'tuesday'}});
  test.equal(counts, {added: 1, removed: 0, changed: 0, moved: 0});
  test.equal(coll.findOne(docId), {_id: docId, a: 1});
  stream.receive({msg: 'data', collection: coll_name, id: 'monkey',
                  set: {value: 'bla'}});
  test.equal(counts, {added: 2, removed: 0, changed: 0, moved: 0});
  test.equal(coll.findOne(docId), {_id: docId, a: 1});
  var newDoc = coll.findOne({value: 'bla'});
  test.isTrue(newDoc);
  test.equal(newDoc, {_id: newDoc._id, value: 'bla'});

  // get method satisfied. all data shows up. the 'a' field is reverted and
  // 'value' field is set.
  stream.receive({msg: 'data', 'methods': [message.id]});
  test.equal(counts, {added: 2, removed: 0, changed: 1, moved: 0});
  test.equal(coll.findOne(docId), {_id: docId, value: 'tuesday'});
  test.equal(coll.findOne(newDoc._id), {_id: newDoc._id, value: 'bla'});

  handle.stop();
});


// initial connect
// make a sub
// do a method
// satisfy sub
// reconnect
// method gets resent
// get data from server
// data NOT shown
// satisfy method
// data NOT shown
// resatisfy sub
// data is shown
Tinytest.add("livedata stub - reconnect", function (test) {
  var stream = new Meteor._StubStream();
  var conn = newConnection(stream);

  startAndConnect(test, stream);

  var coll_name = Meteor.uuid();
  var coll = new Meteor.Collection(coll_name, {manager: conn});

  // setup observers
  var counts = {added: 0, removed: 0, changed: 0, moved: 0};
  var handle = coll.find({}).observe(
    { added: function () { counts.added += 1; },
      removed: function () { counts.removed += 1; },
      changed: function () { counts.changed += 1; },
      moved: function () { counts.moved += 1; }
    });

  // subscribe
  var sub_callback_fired = false;
  var sub = conn.subscribe('my_data', function () {
    sub_callback_fired = true;
  });
  test.isFalse(sub_callback_fired);

  var sub_message = JSON.parse(stream.sent.shift());
  test.equal(sub_message, {msg: 'sub', name: 'my_data', params: [],
                           id: sub_message.id});


  // get some data. it shows up.
  stream.receive({msg: 'data', collection: coll_name,
                  id: '1234', set: {a:1}});

  test.equal(coll.find({}).count(), 1);
  test.equal(counts, {added: 1, removed: 0, changed: 0, moved: 0});
  test.isFalse(sub_callback_fired);

  stream.receive({msg: 'data', collection: coll_name,
                  id: '1234', set: {b:2},
                  subs: [sub_message.id] // satisfy sub
                 });
  test.isTrue(sub_callback_fired);
  sub_callback_fired = false; // re-arm for test that it doesn't fire again.

  test.equal(coll.find({a:1, b:2}).count(), 1);
  test.equal(counts, {added: 1, removed: 0, changed: 1, moved: 0});

  // call method.
  var method_callback_fired = false;
  conn.call('do_something', function () {
    method_callback_fired = true;
  });
  conn.apply('do_something', [], {wait: true});

  test.isFalse(method_callback_fired);

  var method_message = JSON.parse(stream.sent.shift());
  var wait_method_message = JSON.parse(stream.sent.shift());
  test.equal(method_message, {msg: 'method', method: 'do_something',
                              params: [], id:method_message.id});
  test.equal(wait_method_message, {msg: 'method', method: 'do_something',
                                   params: [], id: wait_method_message.id});

  // more data. shows up immediately because there was no relevant method stub.
  stream.receive({msg: 'data', collection: coll_name,
                  id: '1234', set: {c:3}});
  test.equal(coll.findOne('1234'), {_id: '1234', a: 1, b: 2, c: 3});
  test.equal(counts, {added: 1, removed: 0, changed: 2, moved: 0});

  // stream reset. reconnect!
  // we send a connect, our pending messages, and our subs.
  stream.reset();

  test_got_message(test, stream, {msg: 'connect', session: SESSION_ID});
  test_got_message(test, stream, method_message);
  test_got_message(test, stream, wait_method_message);
  test_got_message(test, stream, sub_message);

  // reconnect with different session id
  stream.receive({msg: 'connected', session: SESSION_ID + 1});

  // resend data. doesn't show up.
  stream.receive({msg: 'data', collection: coll_name,
                  id: '1234', set: {a:1, b:2, c:3, d: 4}});
  stream.receive({msg: 'data', collection: coll_name,
                  id: '2345', set: {e: 5}});
  test.equal(coll.findOne('1234'), {_id: '1234', a: 1, b: 2, c: 3});
  test.isFalse(coll.findOne('2345'));
  test.equal(counts, {added: 1, removed: 0, changed: 2, moved: 0});

  // satisfy and return method callback
  stream.receive({msg: 'data',
                  methods: [method_message.id, wait_method_message.id]});

  test.isFalse(method_callback_fired);
  stream.receive({msg: 'result', id:method_message.id, result:"bupkis"});
  stream.receive({msg: 'result', id:wait_method_message.id, result:"bupkis"});
  test.isTrue(method_callback_fired);

  // still no update.
  test.equal(coll.findOne('1234'), {_id: '1234', a: 1, b: 2, c: 3});
  test.isFalse(coll.findOne('2345'));
  test.equal(counts, {added: 1, removed: 0, changed: 2, moved: 0});

  // re-satisfy sub
  stream.receive({msg: 'data', subs: [sub_message.id]});

  // now the doc changes
  test.equal(coll.findOne('1234'), {_id: '1234', a: 1, b: 2, c: 3, d: 4});
  test.equal(coll.findOne('2345'), {_id: '2345', e: 5});
  test.equal(counts, {added: 2, removed: 0, changed: 3, moved: 0});

  handle.stop();
});

Tinytest.add("livedata connection - reactive userId", function (test) {
  var stream = new Meteor._StubStream();
  var conn = newConnection(stream);

  test.equal(conn.userId(), null);
  conn.setUserId(1337);
  test.equal(conn.userId(), 1337);
});

Tinytest.add("livedata connection - two wait methods with reponse in order", function (test) {
  var stream = new Meteor._StubStream();
  var conn = newConnection(stream);
  startAndConnect(test, stream);

  // setup method
  conn.methods({do_something: function (x) {}});

  var responses = [];
  conn.apply('do_something', ['one!'], function() { responses.push('one'); });
  var one_message = JSON.parse(stream.sent.shift());
  test.equal(one_message.params, ['one!']);

  conn.apply('do_something', ['two!'], {wait: true}, function() {
    responses.push('two');
  });
  var two_message = JSON.parse(stream.sent.shift());
  test.equal(two_message.params, ['two!']);
  test.equal(responses, []);

  conn.apply('do_something', ['three!'], function() {
    responses.push('three');
  });
  conn.apply('do_something', ['four!'], {wait: true}, function() {
    responses.push('four');
  });

  conn.apply('do_something', ['five!'], function() { responses.push('five'); });

  // Verify that we did not send "three!" since we're waiting for
  // "one!" and "two!" to send their response back
  test.equal(stream.sent.length, 0);
  stream.receive({msg: 'result', id: one_message.id});
  test.equal(responses, ['one']);

  test.equal(stream.sent.length, 0);
  stream.receive({msg: 'result', id: two_message.id});
  test.equal(responses, ['one', 'two']);

  // Verify that we just sent "three!" and "four!" now that we got
  // responses for "one!" and "two!"
  test.equal(stream.sent.length, 2);
  var three_message = JSON.parse(stream.sent.shift());
  test.equal(three_message.params, ['three!']);
  var four_message = JSON.parse(stream.sent.shift());
  test.equal(four_message.params, ['four!']);

  stream.receive({msg: 'result', id: three_message.id});
  test.equal(responses, ['one', 'two', 'three']);

  test.equal(stream.sent.length, 0);
  stream.receive({msg: 'result', id: four_message.id});
  test.equal(responses, ['one', 'two', 'three', 'four']);

  // Verify that we just sent "five!"
  test.equal(stream.sent.length, 1);
  var five_message = JSON.parse(stream.sent.shift());
  test.equal(five_message.params, ['five!']);
});

Tinytest.add("livedata connection - one wait method with response out of order", function (test) {
  var stream = new Meteor._StubStream();
  var conn = newConnection(stream);
  startAndConnect(test, stream);

  // setup method
  conn.methods({do_something: function (x) {}});

  var responses = [];
  conn.apply('do_something', ['one!'], function() { responses.push('one'); });
  var one_message = JSON.parse(stream.sent.shift());
  test.equal(one_message.params, ['one!']);

  conn.apply('do_something', ['two!'], {wait: true}, function() {
    responses.push('two');
  });
  var two_message = JSON.parse(stream.sent.shift());
  test.equal(two_message.params, ['two!']);
  test.equal(responses, []);

  conn.apply('do_something', ['three!']);

  // Verify that we did not send "three!" since we're waiting for
  // "one!" and "two!" to send their response back
  test.equal(stream.sent.length, 0);
  stream.receive({msg: 'result', id: two_message.id});
  test.equal(responses, []);

  test.equal(stream.sent.length, 0);
  stream.receive({msg: 'result', id: one_message.id});
  test.equal(responses, ['one', 'two']); // Namely not two, one

  // Verify that we just sent "three!" now that we got responses for
  // "one!" and "two!"
  test.equal(stream.sent.length, 1);
  var three_message = JSON.parse(stream.sent.shift());
  test.equal(three_message.params, ['three!']);
  // Since we sent it, it should no longer be in "blocked_methods".
  test.equal(conn.blocked_methods, []);
});

Tinytest.add("livedata connection - onReconnect prepends messages correctly with a wait method", function(test) {
  var stream = new Meteor._StubStream();
  var conn = newConnection(stream);
  startAndConnect(test, stream);

  // setup method
  conn.methods({do_something: function (x) {}});

  conn.onReconnect = function() {
    conn.apply('do_something', ['reconnect one']);
    conn.apply('do_something', ['reconnect two'], {wait: true});
    conn.apply('do_something', ['reconnect three']);
  };

  conn.apply('do_something', ['one']);
  conn.apply('do_something', ['two'], {wait: true});
  conn.apply('do_something', ['three']);

  // reconnect
  stream.sent = [];
  stream.reset();
  test_got_message(
    test, stream, {msg: 'connect', session: conn.last_session_id});

  // Test that we sent what we expect to send, and we're blocked on
  // what we expect to be blocked. The subsequent logic to correctly
  // read the wait flag is tested separately.
  test.equal(_.map(stream.sent, function(msg) {
    return JSON.parse(msg).params[0];
  }), ['reconnect one', 'reconnect two']);
  test.equal(_.map(conn.blocked_methods, function(method) {
    return [method.msg.params[0], method.wait];
  }), [
    ['reconnect three', undefined/*==false*/],
    ['one', undefined/*==false*/],
    ['two', true],
    ['three', undefined/*==false*/]
  ]);
});

Tinytest.add("livedata connection - onReconnect prepends messages correctly without a wait method", function(test) {
  var stream = new Meteor._StubStream();
  var conn = newConnection(stream);
  startAndConnect(test, stream);

  // setup method
  conn.methods({do_something: function (x) {}});

  conn.onReconnect = function() {
    conn.apply('do_something', ['reconnect one']);
    conn.apply('do_something', ['reconnect two']);
    conn.apply('do_something', ['reconnect three']);
  };

  conn.apply('do_something', ['one']);
  conn.apply('do_something', ['two'], {wait: true});
  conn.apply('do_something', ['three']);

  // reconnect
  stream.sent = [];
  stream.reset();
  test_got_message(
    test, stream, {msg: 'connect', session: conn.last_session_id});

  // Test that we sent what we expect to send, and we're blocked on
  // what we expect to be blocked. The subsequent logic to correctly
  // read the wait flag is tested separately.
  test.equal(_.map(stream.sent, function(msg) {
    return JSON.parse(msg).params[0];
  }), ['reconnect one', 'reconnect two', 'reconnect three', 'one', 'two']);
  test.equal(_.map(conn.blocked_methods, function(method) {
    return [method.msg.params[0], method.wait];
  }), [
    ['three', undefined/*==false*/]
  ]);
});

// XXX also test:
// - reconnect, with session resume.
// - restart on update flag
// - on_update event
// - reloading when the app changes, including session migration
