using MEditService.LoadOrder;
using MEditService.RepositoriesLib;

namespace MEditService.Commands;

/// <summary>A script's create gesture: the plugin goes into the place its origin names, one the gesture's pick offers.</summary>
public sealed class CreatePluginInModHandler
{
    private readonly CreatePluginHandler _create;
    private readonly LoadOrderHolder _holder;

    internal CreatePluginInModHandler(CreatePluginHandler create, LoadOrderHolder holder) =>
        (_create, _holder) = (create, holder);

    /// <summary>As <see cref="CreatePluginHandler.CreatePlugin"/> answers.</summary>
    public async Task<Answer<PluginCreated, PluginCreateRefused>> CreatePluginIn(
        string origin, string name, IReadOnlyList<string>? flags = null)
    {
        if (_holder.Held is not { Snapshot: var loadOrder })
            return new PluginCreateRefused(PluginCreateRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage);
        if (!PlaceOf(loadOrder, origin, name).Holds(out var place, out var refused)) return refused;

        return await _create.CreatePlugin(new PluginAddress(name, place.Name), place.Folder, place.SourceFolder, flags);
    }

    /// <summary>The enabled mod or Overwrite <paramref name="origin"/> names, which a new plugin named <paramref name="name"/> goes into.</summary>
    internal static Answer<PluginPlace, PluginCreateRefused> PlaceOf(LoadOrderSnapshot loadOrder, string origin, string name) =>
        loadOrder.Places.FirstOrDefault(held => string.Equals(held.Name, origin, StringComparison.OrdinalIgnoreCase)) is { } place
            ? place
            : new PluginCreateRefused(PluginCreateRefusal.OriginNotAMod, $"'{origin}' is not an enabled mod or Overwrite, so {name} was not created in it.");
}
