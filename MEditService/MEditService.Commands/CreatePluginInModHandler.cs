using MEditService.LoadOrder;

namespace MEditService.Commands;

/// <summary>A script's create gesture: the plugin goes into the mod its origin names, and the write is marked for the
/// next read to wait on (ADR-0015).</summary>
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

        var mod = loadOrder.Plugins
            .Select(held => held.Provider)
            .OfType<PluginProvider.FromMod>()
            .FirstOrDefault(provider => string.Equals(provider.Name, origin, StringComparison.OrdinalIgnoreCase));
        if (mod is null)
        {
            return new PluginCreateResult(PluginCreateRefusal.OriginNotAMod,
                $"'{origin}' is not a mod the load order holds a plugin of, so {name} was not created in it.");
        }

        var created = new PluginAddress(name, mod.Name);
        var result = await _create.CreatePlugin(created, mod.Folder, mod.SourceFolder);
        if (result.Refusal is null) _holder.SourceWritten();
        return result with { Created = created };
    }
}
