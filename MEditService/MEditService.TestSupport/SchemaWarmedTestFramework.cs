using System.Reflection;
using Mutagen.Bethesda;
using Xunit.Abstractions;

namespace MEditService.TestSupport;

/// <summary>Schema reflection costs seconds once per process, so it runs before any test does
/// rather than inside whichever tests start first on each thread.</summary>
public class SchemaWarmedTestFramework(IMessageSink messageSink) : GamesRegisteredTestFramework(messageSink)
{
    public static void WarmSchemas()
    {
        _ = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        _ = SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE);
        _ = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Starfield);
    }

    protected virtual void Warm() => WarmSchemas();

    protected override ITestFrameworkExecutor CreateExecutor(AssemblyName assemblyName)
    {
        Warm();
        return base.CreateExecutor(assemblyName);
    }
}
