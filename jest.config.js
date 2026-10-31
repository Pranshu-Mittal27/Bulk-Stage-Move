import { createDefaultEsmPreset } from 'ts-jest';

const config = {
  ...createDefaultEsmPreset({ tsconfig: 'tsconfig.json' }),
  testEnvironment: 'node',
  testRegex: '.*\\.spec\\.ts$',
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};

export default config;
