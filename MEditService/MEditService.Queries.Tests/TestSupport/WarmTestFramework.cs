using System.Reflection;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Xunit.Abstractions;
using Xunit.Sdk;

[assembly: TestFramework("MEditService.Queries.Tests.TestSupport.WarmTestFramework", "MEditService.Queries.Tests")]

namespace MEditService.Queries.Tests.TestSupport;

/// <summary>Schema reflection costs seconds once per process, so it runs before any test does
/// rather than inside whichever tests start first on each thread.</summary>
public sealed class WarmTestFramework(IMessageSink messageSink) : XunitTestFramework(messageSink)
{
    protected override ITestFrameworkExecutor CreateExecutor(AssemblyName assemblyName)
    {
        _ = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        return base.CreateExecutor(assemblyName);
    }
}
