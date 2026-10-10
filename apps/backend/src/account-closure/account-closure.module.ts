import { forwardRef, Module } from '@nestjs/common';
import { MeteringModule } from '../metering/metering.module';
import { DocksModule } from '../docks/docks.module';
import { MailModule } from '../mail/mail.module';
import { AccountClosureController } from './account-closure.controller';
import { AccountClosureService } from './account-closure.service';
import { SshConnectionRegistry } from './ssh-connection-registry';

/** Close/reopen/erase over dock archiving plus credential revocation. */
@Module({
  imports: [forwardRef(() => DocksModule), MeteringModule, MailModule],
  controllers: [AccountClosureController],
  providers: [AccountClosureService, SshConnectionRegistry],
  exports: [AccountClosureService, SshConnectionRegistry],
})
export class AccountClosureModule {}
