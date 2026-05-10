import { describe, it, expect } from 'vitest';
import { escapeHtml, getContent, getUserName } from '../src/bot';
import type { TelegramUser, TelegramMessage } from '../src/types';

describe('escapeHtml', () => {
  it('should escape all HTML special characters', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#039;');
  });

  it('should escape ampersands', () => {
    expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
  });

  it('should escape angle brackets', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('should escape double quotes', () => {
    expect(escapeHtml('a="b"')).toBe('a=&quot;b&quot;');
  });

  it('should escape single quotes', () => {
    expect(escapeHtml("a='b'")).toBe('a=&#039;b&#039;');
  });

  it('should return empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('should return empty string for falsy input', () => {
    expect(escapeHtml(null as unknown as string)).toBe('');
    expect(escapeHtml(undefined as unknown as string)).toBe('');
  });

  it('should not modify safe text', () => {
    expect(escapeHtml('Hello World 123')).toBe('Hello World 123');
  });

  it('should handle mixed content', () => {
    expect(escapeHtml('Hello <b>World</b> & "Friends"')).toBe('Hello &lt;b&gt;World&lt;/b&gt; &amp; &quot;Friends&quot;');
  });

  it('should handle unicode text', () => {
    expect(escapeHtml('你好世界')).toBe('你好世界');
  });
});

describe('getContent', () => {
  const baseMsg = {
    message_id: 1,
    date: 0,
    chat: { id: 1, type: 'private' as const },
    from: { id: 1, is_bot: false, first_name: 'Test' },
  };

  it('should detect text messages', () => {
    const msg: TelegramMessage = { ...baseMsg, text: 'hello' };
    const result = getContent(msg);
    expect(result.type).toBe('text');
    expect(result.text).toBe('hello');
  });

  it('should detect photo messages', () => {
    const msg: TelegramMessage = { ...baseMsg, photo: [{ file_id: 'x', file_unique_id: 'y', width: 100, height: 100 }], caption: 'a photo' };
    const result = getContent(msg);
    expect(result.type).toBe('photo');
    expect(result.text).toBe('a photo');
  });

  it('should detect video messages', () => {
    const msg: TelegramMessage = { ...baseMsg, video: { file_id: 'x', file_unique_id: 'y', width: 100, height: 100, duration: 10 } };
    const result = getContent(msg);
    expect(result.type).toBe('video');
    expect(result.text).toBe('[video]');
  });

  it('should detect sticker messages', () => {
    const msg: TelegramMessage = { ...baseMsg, sticker: { file_id: 'x', file_unique_id: 'y', width: 100, height: 100, is_animated: false, is_video: false, type: 'regular' as const } };
    const result = getContent(msg);
    expect(result.type).toBe('sticker');
    expect(result.text).toBe('[sticker]');
  });

  it('should detect voice messages', () => {
    const msg: TelegramMessage = { ...baseMsg, voice: { file_id: 'x', file_unique_id: 'y', duration: 5 } };
    const result = getContent(msg);
    expect(result.type).toBe('voice');
    expect(result.text).toBe('[voice]');
  });

  it('should detect audio messages', () => {
    const msg: TelegramMessage = { ...baseMsg, audio: { file_id: 'x', file_unique_id: 'y', duration: 30 } };
    const result = getContent(msg);
    expect(result.type).toBe('audio');
    expect(result.text).toBe('[audio]');
  });

  it('should detect document messages', () => {
    const msg: TelegramMessage = { ...baseMsg, document: { file_id: 'x', file_unique_id: 'y', file_name: 'test.pdf' }, caption: 'doc caption' };
    const result = getContent(msg);
    expect(result.type).toBe('document');
    expect(result.text).toBe('doc caption');
  });

  it('should prioritize video over photo when both exist', () => {
    const msg: TelegramMessage = {
      ...baseMsg,
      video: { file_id: 'x', file_unique_id: 'y', width: 100, height: 100, duration: 10 },
      photo: [{ file_id: 'x', file_unique_id: 'y', width: 100, height: 100 }],
    };
    const result = getContent(msg);
    expect(result.type).toBe('video');
  });
});

describe('getUserName', () => {
  it('should combine first and last name', () => {
    const user: TelegramUser = { id: 1, is_bot: false, first_name: 'John', last_name: 'Doe' };
    expect(getUserName(user)).toBe('John Doe');
  });

  it('should use first name only when no last name', () => {
    const user: TelegramUser = { id: 1, is_bot: false, first_name: 'John' };
    expect(getUserName(user)).toBe('John');
  });

  it('should fall back to username when no names', () => {
    const user: TelegramUser = { id: 1, is_bot: false, first_name: '', username: 'johndoe' };
    expect(getUserName(user)).toBe('johndoe');
  });

  it('should fall back to User + id when no names or username', () => {
    const user: TelegramUser = { id: 42, is_bot: false, first_name: '' };
    expect(getUserName(user)).toBe('User 42');
  });

  it('should handle unicode names', () => {
    const user: TelegramUser = { id: 1, is_bot: false, first_name: '张', last_name: '三' };
    expect(getUserName(user)).toBe('张 三');
  });
});
