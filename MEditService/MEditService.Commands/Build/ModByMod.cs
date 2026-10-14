using MEditService.Commands.Edits;
using MEditService.Ports;

namespace MEditService.Commands.Build;

/// <summary>A modlist gesture over a selection: each distinct mod lands or is refused on its own, its progress
/// published before each mod and at rest once the gesture ends, however it ends.</summary>
internal static class ModByMod
{
    public static SelectionResult<string, TRefusal, TOutcome> Over<TMod, TRefusal, TOutcome>(
        IReadOnlyList<TMod> mods, Func<TMod, string> nameOf, Action<ModlistProgress> publish,
        Func<TMod, ItemAnswer<TRefusal, TOutcome>> each, CancellationToken cancel)
    {
        var distinct = mods.DistinctBy(nameOf, StringComparer.OrdinalIgnoreCase).ToList();
        List<ItemLanded<string, TOutcome>> landed = [];
        List<ItemRefused<string, TRefusal>> refused = [];
        try
        {
            foreach (var (done, mod) in distinct.Index())
            {
                cancel.ThrowIfCancellationRequested();
                publish(new ModlistProgress(nameOf(mod), done, distinct.Count));
                switch (each(mod))
                {
                    case ItemAnswer<TRefusal, TOutcome>.Wrote wrote:
                        landed.Add(new ItemLanded<string, TOutcome>(nameOf(mod), wrote.Outcome));
                        break;
                    case ItemAnswer<TRefusal, TOutcome>.Refusing refusing:
                        refused.Add(new ItemRefused<string, TRefusal>(nameOf(mod), refusing.Refusal, refusing.Message));
                        break;
                }
            }
        }
        finally
        {
            publish(new ModlistProgress(null, 0, 0));
        }
        return SelectionResult<string, TRefusal, TOutcome>.PerItem(landed, refused);
    }
}
