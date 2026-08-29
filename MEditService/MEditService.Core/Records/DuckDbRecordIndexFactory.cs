using MEditService.Core.Schema;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Core.Records;

/// <summary>The one <see cref="IRecordIndexFactory"/>: a <see cref="DuckDbRecordIndex"/> per game,
/// opened over its persistent file when this factory has somewhere to keep one.</summary>
/// <param name="indexRoot">Where this process keeps its index files — <see cref="IndexFile.DefaultRoot"/>
/// in the composition root, a temp directory in tests. Null means this factory has nowhere to put one
/// and every index it creates is in-memory, whatever Data folder it is handed; that is the shape the
/// suite's several hundred index fixtures want, and the reason the root is a constructor parameter
/// rather than read from the environment inside <see cref="IndexFile"/>.</param>
public sealed class DuckDbRecordIndexFactory(
    ISchemaReflector schemaReflector,
    ITableDdlBuilder ddlBuilder,
    ILogger<DuckDbRecordIndexFactory>? logger = null,
    string? indexRoot = null) : IRecordIndexFactory
{
    private readonly ISchemaReflector _schemaReflector = schemaReflector;
    private readonly ITableDdlBuilder _ddlBuilder = ddlBuilder;
    private readonly ILogger _logger = (ILogger?)logger ?? NullLogger.Instance;
    private readonly string? _indexRoot = indexRoot;

    public IRecordIndex Create(GameRelease gameRelease, string? dataFolderPath = null)
    {
        var databasePath = _indexRoot != null && dataFolderPath != null
            ? IndexFile.PathFor(_indexRoot, gameRelease, dataFolderPath)
            : null;
        var repo = new DuckDbRecordIndex(_schemaReflector, _ddlBuilder, _logger, databasePath);
        repo.Initialize(gameRelease);
        return repo;
    }
}
