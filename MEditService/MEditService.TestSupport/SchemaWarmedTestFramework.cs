using System.Reflection;
using Mutagen.Bethesda;
using Xunit.Abstractions;
using Xunit.Sdk;

namespace MEditService.TestSupport;

/// <summary>Schema reflection costs seconds once per process, so it runs before any test does
/// rather than inside whichever tests start first on each thread.</summary>
public class SchemaWarmedTestFramework(IMessageSink messageSink) : GamesRegisteredTestFramework(messageSink)
{
    protected virtual void Warm()
    {
        _ = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        _ = SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE);
        _ = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Starfield);
    }

    protected override ITestFrameworkExecutor CreateExecutor(AssemblyName assemblyName) =>
        new Executor(assemblyName, SourceInformationProvider, DiagnosticMessageSink, Warm);

    // xUnit exits clean on a throw from CreateExecutor and runs no test on one from RunTestCases.
    // A failed warm-up is reported as an error, which fails the run, and the tests still run.
    private sealed class Executor(
        AssemblyName assemblyName, ISourceInformationProvider sourceInformation, IMessageSink diagnostics, Action warm)
        : XunitTestFrameworkExecutor(assemblyName, sourceInformation, diagnostics)
    {
        protected override void RunTestCases(
            IEnumerable<IXunitTestCase> testCases, IMessageSink executionMessageSink, ITestFrameworkExecutionOptions executionOptions)
        {
            if (Record.Exception(warm) is { } warmUpFailure)
            {
                executionMessageSink.OnMessage(new ErrorMessage(testCases, warmUpFailure));
            }
            base.RunTestCases(testCases, executionMessageSink, executionOptions);
        }
    }
}
