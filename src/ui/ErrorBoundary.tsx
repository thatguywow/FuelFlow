import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './primitives';

/**
 * The last line of defence.
 *
 * React unmounts the entire tree when a render throws and nothing catches it,
 * so before this existed a single bad value anywhere — one malformed food, one
 * unexpected undefined — replaced the whole app with a blank white screen, on a
 * device with no console to look at and no way back except clearing the app's
 * data. For a tracker holding months of somebody's diary that is the worst
 * possible failure: their data is safe in IndexedDB, but they cannot reach it
 * and have no reason to believe it survived.
 *
 * What this offers instead is a screen that says what happened, keeps the error
 * where it can be read or reported, and gives two ways out that do not touch
 * any user data.
 */
interface Props {
  children: ReactNode;
  /** Name of the area being guarded, shown so a report says where it broke. */
  area?: string;
}

interface State {
  error: Error | null;
  info: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in state rather than sent anywhere. There is no telemetry in this
    // app and adding some here would break the promise the rest of it makes.
    this.setState({ info: info.componentStack?.slice(0, 1200) ?? '' });
    // eslint-disable-next-line no-console
    console.error(`[FuelFlow] ${this.props.area ?? 'app'} crashed`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null, info: '' });

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const report = `${error.name}: ${error.message}\n\n${error.stack ?? ''}\n\n${info}`.trim();

    return (
      <div className="safe-t safe-b flex min-h-[100dvh] flex-col justify-center gap-5 px-6">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.01em]">Something went wrong</h1>
          <p className="mt-2 text-[14px] leading-relaxed text-dim">
            {this.props.area ? `The ${this.props.area} screen` : 'The app'} hit an error and stopped.
            Nothing you have logged is affected — your diary lives on this device and none of it was
            touched.
          </p>
        </div>

        <div className="rounded-(--radius-card) border border-border bg-surface p-3">
          <p className="font-mono text-[11.5px] leading-relaxed text-faint">
            {error.name}: {error.message}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Button variant="primary" full onClick={this.reset}>
            Try again
          </Button>
          <Button full onClick={() => window.location.reload()}>
            Reload the app
          </Button>
          <Button
            variant="secondary"
            full
            onClick={() => void navigator.clipboard?.writeText(report).catch(() => undefined)}
          >
            Copy the details
          </Button>
        </div>

        <p className="px-1 text-center text-[11.5px] leading-relaxed text-faint">
          Reloading is safe. If it keeps happening, the copied details say exactly where it broke —
          they contain no personal data, only the code path.
        </p>
      </div>
    );
  }
}
