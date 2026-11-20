using System.Reflection;
using System.Text;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Serilog;
using Serilog.Core;
using Serilog.Events;
using Xunit.Abstractions;
using Xunit.Sdk;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>The backend's warnings and errors, written to the output of the test whose flow logged them.</summary>
internal static class TestOutput
{
    private static readonly AsyncLocal<StringBuilder?> Captured = new();

    internal static readonly ILoggerFactory LoggerFactory = Microsoft.Extensions.Logging.LoggerFactory.Create(
        logging => logging.SetMinimumLevel(LogLevel.Warning).AddProvider(new Provider()));

    internal static readonly ILogEventSink SerilogWarnings = new SerilogSink();

    internal static void Started() => Captured.Value = new StringBuilder();

    internal static string Written()
    {
        var written = Captured.Value;
        if (written is null) return "";
        lock (written) return written.ToString();
    }

    private static void WriteLine(string line, Exception? exception)
    {
        var written = Captured.Value;
        if (written is null) return;
        lock (written)
        {
            written.AppendLine(line);
            if (exception is not null) written.AppendLine(exception.ToString());
        }
    }

    private sealed class Provider : ILoggerProvider
    {
        public Microsoft.Extensions.Logging.ILogger CreateLogger(string categoryName) => new Logger(categoryName);

        public void Dispose() { }
    }

    private sealed class Logger(string category) : Microsoft.Extensions.Logging.ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            WriteLine($"{logLevel} {category}: {formatter(state, exception)}", exception);
    }

    private sealed class SerilogSink : ILogEventSink
    {
        public void Emit(LogEvent logEvent) =>
            WriteLine($"{logEvent.Level}: {logEvent.RenderMessage()}", logEvent.Exception);
    }
}

/// <summary>Each test's result, its output joined by what <see cref="TestOutput"/> took while it ran.</summary>
internal sealed class TestOutputSink(IMessageBus bus) : LongLivedMarshalByRefObject, IMessageSink
{
    public bool OnMessage(IMessageSinkMessage message)
    {
        if (message is ITestStarting) TestOutput.Started();
        return bus.QueueMessage(message switch
        {
            ITestPassed passed => new TestPassed(passed.Test, passed.ExecutionTime, passed.Output + TestOutput.Written()),
            ITestFailed failed => new TestFailed(
                failed.Test, failed.ExecutionTime, failed.Output + TestOutput.Written(),
                failed.ExceptionTypes, failed.Messages, failed.StackTraces, failed.ExceptionParentIndices),
            _ => message,
        });
    }
}

/// <summary>A test's messages reach <see cref="TestOutputSink"/> on the test's own flow only when xUnit reports
/// them synchronously; the sink passes them on to the runner through a bus of its own.</summary>
public sealed class TestOutputFramework : SchemaWarmedTestFramework
{
    public TestOutputFramework(IMessageSink messageSink) : base(messageSink) =>
        Log.Logger = new LoggerConfiguration().MinimumLevel.Warning().WriteTo.Sink(TestOutput.SerilogWarnings).CreateLogger();

    protected override ITestFrameworkExecutor CreateExecutor(AssemblyName assemblyName) => new Executor(base.CreateExecutor(assemblyName));

    private sealed class Executor(ITestFrameworkExecutor executor) : LongLivedMarshalByRefObject, ITestFrameworkExecutor
    {
        public ITestCase Deserialize(string value) => executor.Deserialize(value);

        public void RunAll(IMessageSink executionMessageSink, ITestFrameworkDiscoveryOptions discoveryOptions, ITestFrameworkExecutionOptions executionOptions) =>
            executor.RunAll(Capturing(executionMessageSink, executionOptions), discoveryOptions, executionOptions);

        public void RunTests(IEnumerable<ITestCase> testCases, IMessageSink executionMessageSink, ITestFrameworkExecutionOptions executionOptions) =>
            executor.RunTests(testCases, Capturing(executionMessageSink, executionOptions), executionOptions);

        private readonly List<MessageBus> _buses = [];

        public void Dispose()
        {
            foreach (var bus in _buses) bus.Dispose();
            _buses.Clear();
            executor.Dispose();
        }

        private TestOutputSink Capturing(IMessageSink runner, ITestFrameworkExecutionOptions options)
        {
            // xUnit keeps its name for the option internal.
            options.SetValue("xunit.execution.SynchronousMessageReporting", true);
            var bus = new MessageBus(runner, options.StopOnTestFailOrDefault());
            _buses.Add(bus);
            return new TestOutputSink(bus);
        }
    }
}
