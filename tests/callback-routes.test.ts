import { describe, it, expect } from 'vitest';

describe('Callback route matching logic', () => {
  const routes = [
    { pattern: 'cancel_session', match: (d: string) => d === 'cancel_session' },
    { pattern: 'user_list', match: (d: string) => d === 'user_list' },
    { pattern: 'admin_back', match: (d: string) => d === 'admin_back' || d === 'back_to_admin' },
    { pattern: 'pm_user_list_', match: (d: string) => d.startsWith('pm_user_list_') },
    { pattern: 'ignore_msg_', match: (d: string) => d.startsWith('ignore_msg_') },
    { pattern: 'auto_replies_', match: (d: string) => d.startsWith('auto_replies_') },
    { pattern: 'ban_pm_', match: (d: string) => d.startsWith('ban_pm_') },
    { pattern: 'ban_', match: (d: string) => d.startsWith('ban_') },
    { pattern: 'blacklist_', match: (d: string) => d.startsWith('blacklist_') && !isNaN(parseInt(d.split('_')[1], 10)) },
    { pattern: 'reply_', match: (d: string) => d.startsWith('reply_') },
    { pattern: 'unban_pm_', match: (d: string) => d.startsWith('unban_pm_') },
    { pattern: 'pm_user_', match: (d: string) => d.startsWith('pm_user_') },
  ];

  it('should match exact strings', () => {
    expect(routes[0].match('cancel_session')).toBe(true);
    expect(routes[0].match('cancel_session_')).toBe(false);
    expect(routes[0].match('other')).toBe(false);
  });

  it('should match admin_back and back_to_admin', () => {
    expect(routes[2].match('admin_back')).toBe(true);
    expect(routes[2].match('back_to_admin')).toBe(true);
    expect(routes[2].match('admin_back_')).toBe(false);
  });

  it('should prioritize ban_pm_ over ban_', () => {
    const banPmRoute = routes.find(r => r.pattern === 'ban_pm_')!;
    const banRoute = routes.find(r => r.pattern === 'ban_')!;

    expect(banPmRoute.match('ban_pm_123')).toBe(true);
    expect(banRoute.match('ban_pm_123')).toBe(true);

    expect(banPmRoute.match('ban_123')).toBe(false);
    expect(banRoute.match('ban_123')).toBe(true);
  });

  it('should match prefix patterns correctly', () => {
    const pmUserListRoute = routes.find(r => r.pattern === 'pm_user_list_')!;
    expect(pmUserListRoute.match('pm_user_list_0')).toBe(true);
    expect(pmUserListRoute.match('pm_user_list_5')).toBe(true);
    expect(pmUserListRoute.match('pm_user_123')).toBe(false);
  });

  it('should match blacklist_ with numeric ID only', () => {
    const blacklistRoute = routes.find(r => r.pattern === 'blacklist_')!;
    expect(blacklistRoute.match('blacklist_42')).toBe(true);
    expect(blacklistRoute.match('blacklist_abc')).toBe(false);
    expect(blacklistRoute.match('blacklist_add')).toBe(false);
  });

  it('should match reply_ prefix', () => {
    const replyRoute = routes.find(r => r.pattern === 'reply_')!;
    expect(replyRoute.match('reply_123456')).toBe(true);
    expect(replyRoute.match('reply_')).toBe(true);
    expect(replyRoute.match('replies_123')).toBe(false);
  });

  it('should not match empty data', () => {
    for (const route of routes) {
      expect(route.match('')).toBe(false);
    }
  });

  it('should simulate route dispatch order for ban_pm_ vs ban_', () => {
    const orderedRoutes = [
      { match: (d: string) => d.startsWith('ban_pm_'), name: 'ban_pm_' },
      { match: (d: string) => d.startsWith('ban_'), name: 'ban_' },
    ];

    const data = 'ban_pm_123';
    let matched = '';
    for (const route of orderedRoutes) {
      if (route.match(data)) {
        matched = route.name;
        break;
      }
    }
    expect(matched).toBe('ban_pm_');
  });
});
