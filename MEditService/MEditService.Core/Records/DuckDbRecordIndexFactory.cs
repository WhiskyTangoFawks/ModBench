using MEditService.Core.Schema;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Core.Records;

public sealed class DuckDbRecordIndexFactory(
    ISchemaReflector schemaReflector,
    ITableDdlBuilder ddlBuilder,
    ILogger<DuckDbRecordIndexFactory>? logger = null) : IRecordRepositoryFactory, IRecordIndexFactory
{
    private readonly ISchemaReflector _schemaReflector = schemaReflector;
    private readonly ITableDdlBuilder _ddlBuilder = ddlBuilder;
    private readonly ILogger _logger = (ILogger?)logger ?? NullLogger.Instance;

    public IRecordRepository Create(GameRelease gameRelease)
    {
        var repo = new DuckDbRecordIndex(_schemaReflector, _ddlBuilder, _logger);
        repo.Initialize(gameRelease);
        return repo;
    }

    // #421: IRecordIndexFactory's own Create, explicit so the plain Create(...) above (still
    // returning IRecordRepository) stays the sole overload-resolution candidate for the several
    // tests that call it directly on the concrete type — until IRecordRepositoryFactory is
    // demolished, at which point this becomes the plain method.
    IRecordIndex IRecordIndexFactory.Create(GameRelease gameRelease) => (IRecordIndex)Create(gameRelease);
}
