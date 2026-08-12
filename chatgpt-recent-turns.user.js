// ==UserScript==
// @name         ChatGPT Recent Messages
// @namespace    https://github.com/nonlog/my_scripts
// @version      0.2.0
// @description  Keep long ChatGPT conversations responsive by showing only recent messages and revealing older messages on demand.
// @match        https://chatgpt.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const INITIAL_MESSAGES = 5;
  const LOAD_STEP = 5;
  const