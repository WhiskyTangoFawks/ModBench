using MEditService.Core.Schema;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Core.Records;

public sealed class DuckDbRecordRepositoryFactory(
    ISchemaReflector schemaReflector,
    ITableDdlBuilder ddlBuilder,
    ILogger<DuckDbRecordRepositoryFactory>? logger = null) : IRecordRepositoryFactory
{
    private readonly ISchemaReflector _schemaReflector = schemaReflector;
    private readonly ITableDdlBuilder _ddlBuilder = ddlBuilder;
    private readonly ILogger _logger = (ILogger?)logger ?? NullLogger.Instance;

    public IRecordRepository Create(GameRelease gameRelease)
    {
        var repo = new DuckDbRecordRepository(_schemaReflector, _ddlBuilder, _logger);
        repo.Initialize(gameRelease);
        return repo;
    }
}
