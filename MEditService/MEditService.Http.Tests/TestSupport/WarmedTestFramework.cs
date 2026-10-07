using System.Reflection;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Xunit.Abstractions;
using Xunit.Sdk;

[assembly: TestFramework("MEditService.Http.Tests.TestSupport.WarmedTestFramework", "MEditService.Http.Tests")]

namespace MEditService.Http.Tests.TestSupport;

/// <summary>Walks each gesture once before the first test starts, so the seconds of JIT the first
/// calls cost are no test's time and cannot break the per-test ceiling under load.</summary>
public sealed class WarmedTestFramework(IMessageSink diagnostics) : XunitTestFramework(diagnostics)
{
    protected override ITestFrameworkExecutor CreateExecutor(AssemblyName assemblyName) =>
        new Executor(assemblyName, SourceInformationProvider, DiagnosticMessageSink);

    private sealed class Executor(AssemblyName assemblyName, ISourceInformationProvider sourceInformation, IMessageSink diagnostics)
        : XunitTestFrameworkExecutor(assemblyName, sourceInformation, diagnostics)
    {
        protected override void RunTestCases(
            IEnumerable<IXunitTestCase> testCases, IMessageSink executionMessageSink, ITestFrameworkExecutionOptions executionOptions)
        {
            Warm().GetAwaiter().GetResult();
            base.RunTestCases(testCases, executionMessageSink, executionOptions);
        }
    }

    private static async Task Warm()
    {
        const string Plugin = "Warm.esp";
        const string Origin = "WarmMod";
        using var fx = new PluginFixtureBuilder("warm-up")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("WarmNpc"), origin: Origin)
            .BuildScattered();
        using var host = new MEditHost();
        using var client = host.CreateClient();

        (await client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await client.Track(Origin)).EnsureSuccessStatusCode();
        await client.NextSnapshot(fx);
        await client.PluginReportsTracked(Plugin);
        var formKey = await client.FirstFormKey(Plugin, Origin);
        (await client.Edit(formKey, Plugin, Origin, "HeightMax", 0.75)).EnsureSuccessStatusCode();
        (await client.Compile([(Plugin, Origin)])).EnsureSuccessStatusCode();
        (await client.Decompile([(Plugin, Origin)])).EnsureSuccessStatusCode();
    }
}
