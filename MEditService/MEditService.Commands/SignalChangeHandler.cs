using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>Tells the record index's reader of the files that any of them may have changed (ADR-0015), and checks the held
/// load order's compiled plugins for a change made outside Modbench (ADR-0003).</summary>
public sealed class SignalChangeHandler
{
    private readonly LoadOrderHolder _holder;
    private readonly ISourceAdapter _source;
    private readonly ExternalChangeCheck _externalChanges;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal SignalChangeHandler(LoadOrderHolder holder, ISourceAdapter source, ExternalChangeCheck externalChanges) =>
        (_holder, _source, _externalChanges) = (holder, source, externalChanges);

    public void Signal()
    {
        _source.SignalChange();
        if (_holder.Held is { Snapshot: var snapshot }) _externalChanges.Check(snapshot);
    }
}
