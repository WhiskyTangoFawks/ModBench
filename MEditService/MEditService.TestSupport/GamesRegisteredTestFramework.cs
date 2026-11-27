using System.Reflection;
using MEditService.Codec.Fallout4;
using MEditService.Codec.Serialization;
using MEditService.Codec.Skyrim;
using MEditService.Codec.Starfield;
using Mutagen.Bethesda;
using Xunit.Abstractions;
using Xunit.Sdk;

namespace MEditService.TestSupport;

/// <summary>The game projects registered before any test runs, as the composition root registers
/// them before the service starts. A cost paid once per process runs in <see cref="Warm"/>, before the
/// first test starts, so no test's time holds it and the ceiling judges each test on its own cost.</summary>
public class GamesRegisteredTestFramework : XunitTestFramework
{
    public GamesRegisteredTestFramework(IMessageSink messageSink) : base(messageSink) =>
        GameCodecs.Register(new Dictionary<GameCategory, IGameCodec>
        {
            [GameCategory.Fallout4] = Fallout4Codec.Instance,
            [GameCategory.Skyrim] = SkyrimCodec.Instance,
            [GameCategory.Starfield] = StarfieldCodec.Instance,
        });

    protected virtual void Warm() { }

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
            try
            {
                warm();
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                executionMessageSink.OnMessage(new ErrorMessage(testCases, ex));
            }
            base.RunTestCases(testCases, executionMessageSink, executionOptions);
        }
    }
}
