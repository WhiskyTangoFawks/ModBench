using Microsoft.Extensions.Logging;

namespace MEditService.TestSupport;

/// <summary>Carries the level and the exception, so a test can tell "logged at Info" from "logged
/// this exception", not just that the message text appeared.</summary>
public sealed record LogEntry(LogLevel Level, string Message, Exception? Exception = null);

/// <summary>Asserts on log output without standing up the full Serilog/host pipeline.</summary>
public sealed class CollectingLoggerProvider(List<LogEntry> entries) : ILoggerProvider
{
    public ILogger CreateLogger(string categoryName) => new CollectingLogger(entries);
    public void Dispose() { }
}

/// <summary>Appends under the list's own lock: a watcher or timer thread logs while the test thread
/// reads, so a reader takes the same lock.</summary>
public sealed class CollectingLogger(List<LogEntry> entries) : ILogger
{
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel logLevel) => true;
    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state,
        Exception? exception, Func<TState, Exception?, string> formatter)
    {
        var entry = new LogEntry(logLevel, formatter(state, exception), exception);
        lock (entries) entries.Add(entry);
    }
}
