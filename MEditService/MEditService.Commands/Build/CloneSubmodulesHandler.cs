using System.Text.Json.Serialization;
using MEditService.Commands.Edits;
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
/// pins, and its check that a submodule is at that commit (modlist-repository.md, Restore from manifest, story 3).</summary>
public sealed class CloneSubmodulesHandler
{
    private readonly ISourceAdapter _source;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal CloneSubmodulesHandler(ISourceAdapter source) => _source = source;

    public CloneSubmodulesResult Clone(IReadOnlyList<Submodule> submodules, CancellationToken cancel)
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
