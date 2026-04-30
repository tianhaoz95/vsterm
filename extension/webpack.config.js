'use strict';

const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  target: 'webworker',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
  },
  externals: {
    vscode: 'commonjs vscode',
  },
  resolve: {
    extensions: ['.ts', '.js'],
    fallback: {
      path: false,
      fs: false,
      os: false,
      crypto: false,
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: 'ts-loader',
      },
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        {
          from: 'node_modules/@xterm/xterm/lib/xterm.js',
          to: '../webview/vendor/xterm.js',
        },
        {
          from: 'node_modules/@xterm/xterm/css/xterm.css',
          to: '../webview/vendor/xterm.css',
        },
        {
          from: 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
          to: '../webview/vendor/addon-fit.js',
        },
        {
          from: 'node_modules/@xterm/addon-web-links/lib/addon-web-links.js',
          to: '../webview/vendor/addon-web-links.js',
        },
      ],
    }),
  ],
  devtool: 'source-map',
};
