import { Pipe, PipeTransform } from '@angular/core';

/** Strips ANSI escape sequences from a raw terraform log so it renders as plain text. */
@Pipe({ name: 'ansiStrip' })
export class AnsiStripPipe implements PipeTransform {
  // eslint-disable-next-line no-control-regex
  private readonly ansi = /\x1b\[[0-9;]*[A-Za-z]/g;
  transform(value: string | null | undefined): string {
    return (value ?? '').replace(this.ansi, '');
  }
}
