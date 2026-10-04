using MEditService.Codec.Schema;
using MEditService.Ports;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Index;

/// <summary>A <see cref="DuckDbRecordIndex"/> per game, opened over the calling instance's
/// persistent file when it names one. A file another window holds answers an index whose
/// HeldElsewhere says so (ADR-0010).</summary>
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

    /// <summary>A null <paramref name="instanceRoot"/> means an in-memory index that dies with this
    /// object.</summary>
    public IRecordIndex Create(GameRelease gameRelease, string? instanceRoot)
    {
        var index = New(instanceRoot);
        if (index.HeldElsewhere is null) index.Initialize(gameRelease);
        return index;
    }

    /// <summary>The reopened sequence is floored at <paramref name="atLeastSequence"/>: this process
    /// may already have answered a caller with a higher value, and Sequence must never regress.</summary>
    public IRecordIndex Rebuild(GameRelease gameRelease, string instanceRoot, long atLeastSequence)
    {
        var index = New(instanceRoot);
        if (index.HeldElsewhere is null) index.RebuildEmpty(gameRelease, atLeastSequence);
        return index;
    }

    private DuckDbRecordIndex New(string? instanceRoot)
    {
        var index = new DuckDbRecordIndex(
            _schemaReflector, _ddlBuilder, _logger, instanceRoot is null ? null : IndexFile.For(instanceRoot),
            _notifications, _timeProvider);
        index.Open();
        return index;
    }
}
