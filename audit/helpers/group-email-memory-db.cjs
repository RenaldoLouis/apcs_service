const assert = require('node:assert/strict');

// A transactional, network-free fixture. There are no Firebase credentials or SMTP clients here.
function memoryDb(records = new Map()) {
    const reads = [];
    const clone = value => value === undefined ? undefined : structuredClone(value);
    let lock = Promise.resolve();
    const snapshot = key => ({ id: key.split('/').pop(), ref: doc(key), exists: records.has(key), data: () => clone(records.get(key)) });
    function doc(key) {
        return { key, id: key.split('/').pop(), get: async () => { reads.push(key); return snapshot(key); },
            collection: name => collection(`${key}/${name}`) };
    }
    function collection(name, filters = [], maximum = Infinity) {
        return { doc: id => doc(`${name}/${id}`), where: (field, operator, value) => {
            assert.equal(operator, '=='); return collection(name, [...filters, [field, value]], maximum);
        }, limit: value => collection(name, filters, value), get: async () => ({ docs: [...records]
            .filter(([key, data]) => key.startsWith(`${name}/`) && key.slice(name.length + 1).indexOf('/') < 0
                && filters.every(([field, value]) => data[field] === value))
            .slice(0, maximum).map(([key]) => snapshot(key)) }) };
    }
    const db = { collection, commitHook: null, runTransaction: operation => {
        const result = lock.then(async () => {
            const writes = [];
            const transaction = {
                get: ref => { assert.equal(writes.length, 0, 'Firestore reads must precede writes'); return ref.get(); },
                set: (ref, data, options) => writes.push({ ref, data: clone(data), merge: options?.merge }),
                update: (ref, data) => {
                    assert.ok(records.has(ref.key), `Missing update document ${ref.key}`);
                    writes.push({ ref, data: clone(data), merge: true });
                },
            };
            const value = await operation(transaction);
            if (db.commitHook) db.commitHook(writes);
            for (const write of writes) records.set(write.ref.key,
                write.merge ? { ...records.get(write.ref.key), ...write.data } : write.data);
            return value;
        });
        lock = result.catch(() => {});
        return result;
    } };
    return { db, records, reads };
}

module.exports = { memoryDb };
