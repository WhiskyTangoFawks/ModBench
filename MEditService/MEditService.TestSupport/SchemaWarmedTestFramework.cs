using System.Reflection;
using Mutagen.Bethesda;
using Xunit.Abstractions;
using Xunit.Sdk;

namespace MEditService.TestSupport;

/// <summary>Schema reflection costs seconds once per process, so it runs before any test does
/// rather than inside whichever tests start first on each thread.</summary>
public class SchemaWarmedTestFramework(IMessageSink messageSink) : XunitTestFramework(messageSink)
{
    public static void WarmSchemas() => _ = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    protected virtual void Warm() => WarmSchemas();

    protected override ITestFrameworkExecutor CreateExecutor(AssemblyName assemblyName)
    {
        Warm();
        return base.CreateExecutor(assemblyName);
    }
}
