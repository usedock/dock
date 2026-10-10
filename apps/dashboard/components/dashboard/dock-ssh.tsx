'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getDefaultApi } from '@/lib/dock-api';
import { useInstanceConfigState } from '@/lib/use-instance-config';
import { CodeBlock } from './code-block';
import { EmptyNote, ErrorNote, LoadingRows } from './data-states';

/** How to SSH into one dock through the instance's SSH gateway. */
export function DockSsh({ dockId, blocked }: { dockId: string; blocked: string | null }) {
  const { config: instance, failed: instanceFailed } = useInstanceConfigState();
  const [keyCount, setKeyCount] = useState<number | null>(null);

  useEffect(() => {
    getDefaultApi()
      .listSshKeys()
      .then((rows) => setKeyCount(rows.length))
      .catch(() => setKeyCount(null));
  }, []);

  if (instanceFailed) return <ErrorNote message="Could not load instance settings. Reload the page to retry." />;
  if (!instance) return <LoadingRows rows={2} />;
  if (!instance.ssh) {
    return (
      <EmptyNote
        title="SSH is turned off on this instance."
        hint="An operator enables it by setting SSH_GATEWAY_PORT on the API. Run commands with the exec API in the meantime; see the Connect tab."
      />
    );
  }

  const { host, port } = instance.ssh;
  const portFlag = port === 22 ? '' : ` -p ${port}`;
  const alias = `dock-${dockId.slice(0, 8)}`;

  return (
    <>
      {blocked ? <EmptyNote title="SSH sessions are unavailable right now." hint={blocked} /> : null}
      {keyCount === 0 ? (
        <EmptyNote
          title="Add an SSH key first."
          hint={
            <>
              The gateway accepts the public keys on your{' '}
              <Link href="/developers/ssh-keys" className="underline underline-offset-4">
                SSH keys
              </Link>{' '}
              page.
            </>
          }
        />
      ) : null}
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Connect</h2>
        <CodeBlock lines={[`ssh${portFlag} ${dockId}@${host}`, '', '# run one command', `ssh${portFlag} ${dockId}@${host} 'uname -a'`]} />
      </div>
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">~/.ssh/config</h2>
        <CodeBlock lines={[`Host ${alias}`, `  HostName ${host}`, `  Port ${port}`, `  User ${dockId}`]} />
        <p className="text-sm text-muted-foreground">
          Then connect with <span className="font-mono">ssh {alias}</span>. Keys are managed on the{' '}
          <Link href="/developers/ssh-keys" className="underline underline-offset-4">
            SSH keys
          </Link>{' '}
          page.
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        Interactive shells and single commands are supported. SCP, SFTP, and SSH port forwarding are not available yet; serve web ports from the Ports tab.
      </p>
    </>
  );
}
