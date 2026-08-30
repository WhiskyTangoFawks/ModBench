using MEditService.Core.Schema;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Core.Records;

/// <summary>The one <see cref="IRecordIndexFactory"/>: a <see cref="DuckDbRecordIndex"/> per game,
/// opened over the calling MO2 instance's persistent file when it names one.</summary>
public sealed class DuckDbRecordIndexFactory(
    SchemaReflector schemaReflector,
    TableDdlBuilder ddlBuilder,
    ILogger<DuckDbRecordIndexFactory>? logger = null) : IRecordIndexFactory
{
    private readonly SchemaReflector _schemaReflector = schemaReflector;
    private readonly TableDdlBuilder _ddlBuilder = ddlBuilder;
    private readonly ILogger _logger = (ILogger?)logger ?? NullLogger.Instance;

    public IRecordIndex Create(GameRelease gameRelease, string? instanceRoot = null)
    {
        var repo = new DuckDbRecordIndex(
            _schemaReflector, _ddlBuilder, _logger,
            instanceRoot is null ? null : IndexFile.For(instanceRoot));
        repo.Initialize(gameRelease);
        return repo;
    }
}
