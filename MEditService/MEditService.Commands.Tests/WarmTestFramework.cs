using System.Reflection;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Xunit.Abstractions;
using Xunit.Sdk;

[assembly: TestFramework("MEditService.Commands.Tests.WarmTestFramework", "MEditService.Commands.Tests")]

namespace MEditService.Commands.Tests;

/// <summary>Mutagen's first write and the schema reflection cost seconds once per process, so they
/// run before any test does rather than inside whichever tests happen to start first.</summary>
public sealed class WarmTestFramework(IMessageSink messageSink) : XunitTestFramework(messageSink)
{
    protected override ITestFrameworkExecutor CreateExecutor(AssemblyName assemblyName)
    {
        _ = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        using var stream = new MemoryStream();
        new Fallout4Mod(ModKey.FromFileName("WarmUp.esp"), Fallout4Release.Fallout4).WriteToBinary(stream);
        return base.CreateExecutor(assemblyName);
    }
}
