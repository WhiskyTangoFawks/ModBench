using Mutagen.Bethesda;
using Xunit.Abstractions;

namespace MEditService.TestSupport;

/// <summary>Schema reflection costs seconds once per process too.</summary>
public class SchemaWarmedTestFramework(IMessageSink messageSink) : GamesRegisteredTestFramework(messageSink)
{
    protected override void Warm()
    {
        base.Warm();
        _ = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        _ = SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE);
        _ = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Starfield);
    }
}
