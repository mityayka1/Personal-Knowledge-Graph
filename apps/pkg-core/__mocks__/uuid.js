// Mock for uuid package
// This mock is used to avoid ESM import issues in Jest tests

const crypto = require('crypto');

module.exports = {
  v4: function uuidv4() {
    return crypto.randomUUID ? crypto.randomUUID() :
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
  },
  v1: jest.fn().mockReturnValue('mock-uuid-v1'),
  validate: jest.fn().mockReturnValue(true),
  version: jest.fn().mockReturnValue(4),
  NIL: '00000000-0000-0000-0000-000000000000',
  MAX: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
};
