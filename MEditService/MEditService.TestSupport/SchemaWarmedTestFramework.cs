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

    // xUnit answers a throw here by skipping the whole assembly and exiting clean. A schema that does
    // not build instead fails, by name, every test that reads it, since a failed build is not cached.
    protected override ITestFrameworkExecutor CreateExecutor(AssemblyName assemblyName)
    {
        try
        {
            Warm();
        }
        catch (InvalidOperationException)
        {
        }
        return base.CreateExecutor(assemblyName);
    }
}
