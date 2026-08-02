using Microsoft.Extensions.Logging;

namespace MEditService.Tests.TestSupport;

/// <summary>
/// One formatted log line captured by <see cref="CollectingLoggerProvider"/>, with the level it
/// was logged at — needed to assert e.g. "this fired at Info", not just "this text appeared".
/// </summary>
public sealed record LogEntry(LogLevel Level, string Message);

/// <summary>
/// Minimal in-memory logger provider for asserting on log output (e.g. "endpoint logged an
/// Info-level reception line") without standing up the full Serilog/host pipeline.
/// </summary>
public sealed class CollectingLoggerProvider(List<LogEntry> entries) : ILoggerProvider
{
    public ILogger CreateLogger(string categoryName) => new CollectingLogger(entries);
    public void Dispose() { }
}

public sealed class CollectingLogger(List<LogEntry> entries) : ILogger
{
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel logLevel) => true;
    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state,
        Exception? exception, Func<TState, Exception?, string> formatter)
        => entries.Add(new LogEntry(logLevel, formatter(state, exception)));
}
