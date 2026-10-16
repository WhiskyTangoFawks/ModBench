using MEditService.LoadOrder;

namespace MEditService.Commands;

/// <summary>A script's create gesture: the plugin goes into the place its origin names, one the gesture's pick offers, and
/// the write is marked for the next read to wait on (ADR-0015).</summary>
public sealed class CreatePluginInModHandler
{
    private readonly CreatePluginHandler _create;
    private readonly LoadOrderHolder _holder;

    internal CreatePluginInModHandler(CreatePluginHandler create, LoadOrderHolder holder) =>
        (_create, _holder) = (create, holder);

    public async Task<PluginCreateResult> CreatePluginIn(string origin, string name)
    {
        if (_holder.Held is not { Snapshot: var loadOrder })
            return new PluginCreateResult(PluginCreateRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage);

        var place = loadOrder.Places.FirstOrDefault(held => string.Equals(held.Name, origin, StringComparison.OrdinalIgnoreCase));
        if (place is null)
        {
            return new PluginCreateResult(PluginCreateRefusal.OriginNotAMod,
                $"'{origin}' is not an enabled mod or Overwrite, so {name} was not created in it.");
        }

        var created = new PluginAddress(name, place.Name);
        var result = await _create.CreatePlugin(created, place.Folder, place.SourceFolder);
        if (result.Refusal is null) _holder.SourceWritten();
        return result with { Created = created };
    }
}
