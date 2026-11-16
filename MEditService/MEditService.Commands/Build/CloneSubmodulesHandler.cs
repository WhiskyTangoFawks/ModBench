using System.Text.Json.Serialization;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Build;

/// <summary>Cloned or not, per submodule (ADR-0019), never the status of the call.</summary>
public sealed record CloneSubmodulesResult(IReadOnlyList<SubmoduleCloned> Applied, IReadOnlyList<SubmoduleNotCloned> Refused)
    : ISelectionAnswer<SubmoduleNotCloned>;

/// <summary>A submodule cloned, by the folder git checked it out in, and why its branch was left elsewhere.</summary>
public sealed record SubmoduleCloned(string Folder, string? LeftDetached = null);

/// <summary>A submodule not cloned, or at another commit than its pin, by the folder git checks it out in, and why.</summary>
public sealed record SubmoduleNotCloned(string Item, CloneRefusal Refusal, string Message) : IItemRefused<CloneRefusal>
{
    object IItemRefused<CloneRefusal>.Item => Item;
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CloneRefusal
{
    None,

    /// <summary>git could not clone it, or not at its pin.</summary>
    NotCloned,

    /// <summary>Its folder holds it at another commit than its pin, and Modbench never moves a repository.</summary>
    AtAnotherCommit,
}

/// <summary>Restore from manifest's clone of each submodule the source folder lacks, at the commit the instance repository
/// pins, and its check that a submodule is at that commit (ADR-0022).</summary>
public sealed class CloneSubmodulesHandler
{
    private readonly ISourceAdapter _source;
    private readonly LoadOrderHolder _loadOrder;
    private readonly HeldWrites _held;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal CloneSubmodulesHandler(ISourceAdapter source, LoadOrderHolder loadOrder, HeldWrites held) =>
        (_source, _loadOrder, _held) = (source, loadOrder, held);

    /// <summary>Answers once the record index has read back each plugin whose source folder, as the held load order names it,
    /// a clone made.</summary>
    public async Task<CloneSubmodulesResult> Clone(IReadOnlyList<Submodule> submodules, CancellationToken cancel)
    {
        var cloned = CloneEach(submodules, cancel);
        await _held.ReadBackSource(SourcedFrom(cloned.Applied.Select(submodule => submodule.Folder)), cancel);
        return cloned;
    }

    private IEnumerable<PluginAddress> SourcedFrom(IEnumerable<string> folders)
    {
        var cloned = folders.Select(Unslashed).ToList();
        return _loadOrder.Current.Plugins
            .Where(plugin => plugin.Provider is PluginProvider.FromMod { SourceFolder: { } sourceFolder }
                && cloned.Exists(folder => string.Equals(folder, Unslashed(sourceFolder), FilePaths.Comparison)))
            .Select(plugin => plugin.Key);
    }

    private static string Unslashed(string folder) => folder.TrimEnd('/', '\\');

    private CloneSubmodulesResult CloneEach(IReadOnlyList<Submodule> submodules, CancellationToken cancel)
    {
        List<SubmoduleCloned> cloned = [];
        List<SubmoduleNotCloned> refused = [];
        foreach (var submodule in submodules)
        {
            if (!_source.CommitAtHead(submodule, cancel).Holds(out var head, out var failure))
                refused.Add(new SubmoduleNotCloned(submodule.Folder, CloneRefusal.NotCloned, failure.Reason));
            else if (head.Commit != submodule.Pin)
                refused.Add(new SubmoduleNotCloned(
                    submodule.Folder, CloneRefusal.AtAnotherCommit, $"its submodule is at {head.Commit}, not at {submodule.Pin}, the commit the instance repository pins"));
            else cloned.Add(new SubmoduleCloned(submodule.Folder, head.LeftDetached));
        }
        return new CloneSubmodulesResult(cloned, refused);
    }
}
