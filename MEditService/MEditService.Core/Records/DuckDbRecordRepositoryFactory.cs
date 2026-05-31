using MEditService.Core.Schema;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Core.Records;

public sealed class DuckDbRecordRepositoryFactory : IRecordRepositoryFactory
{
    private readonly ISchemaReflector _schemaReflector;
    private readonly ITableDdlBuilder _ddlBuilder;
    private readonly ILogger? _logger;

    public DuckDbRecordRepositoryFactory(
        ISchemaReflector schemaReflector,
        ITableDdlBuilder ddlBuilder,
        ILogger<DuckDbRecordRepositoryFactory>? logger = null)
    {
        _schemaReflector = schemaReflector;
        _ddlBuilder = ddlBuilder;
        _logger = logger;
    }

    public IRecordRepository Create(GameRelease gameRelease)
    {
        var repo = new DuckDbRecordRepository(_schemaReflector, _ddlBuilder, _logger);
        repo.Initialize(gameRelease);
        return repo;
    }
}
