using MEditService.Commands.Edits;
using MEditService.Ports;

namespace MEditService.Commands.Build;

/// <summary>A modlist gesture over a selection: each distinct mod lands or is refused on its own.
/// Progress goes before each mod and at rest at the end. A cancel stops it after the mod in hand.</summary>
internal static class ModByMod
{
    public static async Task<PerItemResult<string, TRefusal, TOutcome>> OverAsync<TMod, TRefusal, TOutcome>(
        IReadOnlyList<TMod> mods, Func<TMod, string> nameOf, Action<ModlistProgress> publish,
        Func<TMod, ModlistProgress, Task<ItemAnswer<TRefusal, TOutcome>>> each, CancellationToken cancel)
    {
        var distinct = mods.DistinctBy(nameOf, StringComparer.OrdinalIgnoreCase).ToList();
        List<ItemLanded<string, TOutcome>> landed = [];
        List<ItemRefused<string, TRefusal>> refused = [];
        try
        {
            foreach (var (done, mod) in distinct.Index())
            {
                if (cancel.IsCancellationRequested) break;
                var at = new ModlistProgress(nameOf(mod), done, distinct.Count);
                publish(at);
                switch (await each(mod, at))
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
        return new PerItemResult<string, TRefusal, TOutcome>(landed, refused);
    }
}
