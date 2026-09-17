using MEditService.Codec.Schema;
using MEditService.Ports;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Index;

/// <summary>A <see cref="DuckDbRecordIndex"/> per game, opened over the calling MO2 instance's
/// persistent file when it names one.</summary>
internal sealed class DuckDbRecordIndexFactory(
    SchemaReflector schemaReflector,
    TableDdlBuilder ddlBuilder,
    INotificationPublisher? notifications = null,
    ILogger<DuckDbRecordIndexFactory>? logger = null,
    TimeProvider? timeProvider = null)
{
    private readonly SchemaReflector _schemaReflector = schemaReflector;
    private readonly TableDdlBuilder _ddlBuilder = ddlBuilder;
    private readonly INotificationPublisher? _notifications = notifications;
    private readonly ILogger _logger = (ILogger?)logger ?? NullLogger.Instance;
    private readonly TimeProvider? _timeProvider = timeProvider;

    /// <summary>ADR-0009: <paramref name="instanceRoot"/> keys one persistent file per instance; an
    /// origin is a mod folder name, unique only within one. Null means an in-memory index that dies
    /// with this object.</summary>
    public IRecordIndex Create(GameRelease gameRelease, string? instanceRoot = null)
    {
        var repo = new DuckDbRecordIndex(
            _schemaReflector, _ddlBuilder, _logger,
            instanceRoot is null ? null : IndexFile.For(instanceRoot),
            _notifications, _timeProvider);
        repo.Initialize(gameRelease);
        return repo;
    }

    /// <summary>ADR-0014: drops the instance's index file and reopens it empty, refusing exactly as
    /// <see cref="Create"/> does when another process holds it. Floors the reopened sequence at
    /// <paramref name="atLeastSequence"/>.</summary>
    // Construction alone opens (or refuses) the existing file; RebuildEmpty then drops it.
    public IRecordIndex Rebuild(GameRelease gameRelease, string instanceRoot, long atLeastSequence)
    {
        var repo = new DuckDbRecordIndex(
            _schemaReflector, _ddlBuilder, _logger, IndexFile.For(instanceRoot), _notifications, _timeProvider);
        repo.RebuildEmpty(gameRelease, atLeastSequence);
        return repo;
    }
}
