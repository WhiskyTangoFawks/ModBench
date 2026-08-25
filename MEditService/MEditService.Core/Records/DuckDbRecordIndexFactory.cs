using MEditService.Core.Schema;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Core.Records;

public sealed class DuckDbRecordIndexFactory(
    ISchemaReflector schemaReflector,
    ITableDdlBuilder ddlBuilder,
    ILogger<DuckDbRecordIndexFactory>? logger = null) : IRecordIndexFactory
{
    private readonly ISchemaReflector _schemaReflector = schemaReflector;
    private readonly ITableDdlBuilder _ddlBuilder = ddlBuilder;
    private readonly ILogger _logger = (ILogger?)logger ?? NullLogger.Instance;

    public ISchemaReflector SchemaReflector => _schemaReflector;

    public IRecordIndex Create(GameRelease gameRelease)
    {
        var repo = new DuckDbRecordIndex(_schemaReflector, _ddlBuilder, _logger);
        repo.Initialize(gameRelease);
        return repo;
    }
}
