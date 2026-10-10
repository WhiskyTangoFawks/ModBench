using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;

namespace MEditService.TestSupport;

/// <summary>A value a test just built or a fixture just wrote: missing here is a broken fixture,
/// not a case under test.</summary>
public static class RequireExtensions
{
    public static T Require<T>(this T? value) where T : class =>
        value ?? throw new InvalidOperationException($"Expected a non-null {typeof(T).Name} here; the fixture does not hold what the test built.");

    /// <summary>The value a plugin read or write answered; its failure here is a broken fixture.</summary>
    public static T Answered<T>(this Answer<T, PluginFailure> answer) =>
        answer.Holds(out var value, out var failure)
            ? value
            : throw new InvalidOperationException($"Expected the plugin adapter to answer here: {failure.Reason}");

    /// <summary>A double's answer in place of <paramref name="answer"/>'s value, its failure passed on.</summary>
    public static Answer<TOut, PluginFailure> Map<T, TOut>(this Answer<T, PluginFailure> answer, Func<T, TOut> map) =>
        answer.Holds(out var value, out var failure) ? PluginAnswer.Of(map(value)) : failure;

    /// <summary>A double's answer of a value it makes.</summary>
    public static Answer<T, PluginFailure> AnswerOf<T>(Func<T> make) => PluginAnswer.Of(make());

    /// <summary>The failure a plugin read or write answered, which the test asked for.</summary>
    public static PluginFailure Failure<T>(this Answer<T, PluginFailure> answer) =>
        answer.Holds(out _, out var failure)
            ? throw new InvalidOperationException("Expected the plugin adapter to answer a failure here.")
            : failure;

    /// <summary>The value a source read or write answered; its failure here is a broken fixture.</summary>
    public static T Value<T>(this Answer<T, SourceFailure> answer) =>
        answer.Holds(out var value, out var failure)
            ? value
            : throw new InvalidOperationException($"Expected the source adapter to answer here: {failure.Reason}");

    /// <summary>The failure a source read or write answered, which the test asked for.</summary>
    public static SourceFailure Stopped<T>(this Answer<T, SourceFailure> answer) =>
        answer.Holds(out _, out var failure)
            ? throw new InvalidOperationException("Expected the source adapter to answer a failure here.")
            : failure;

    /// <summary>A source write that answers no value went through; its failure here is a broken fixture.</summary>
    public static void Wrote(this SourceFailure? failure)
    {
        if (failure is not null) throw new InvalidOperationException($"Expected the source write to go through: {failure.Reason}");
    }

    /// <summary>The failure a source write answered, which the test asked for.</summary>
    public static SourceFailure Failed(this SourceFailure? failure) =>
        failure ?? throw new InvalidOperationException("Expected the source write to answer a failure here.");

    /// <summary>Saves the changes that put the document in the tree, or answers why the repository answered none.</summary>
    public static SourceFailure? Put(this ISourceRepository repository, PluginAddress plugin, SourceDocument document) =>
        repository.SaveChanges(repository.ChangesToPut(plugin, document));

    /// <summary>Saves the changes that take the record out of the tree, or answers why the repository answered none.</summary>
    public static SourceFailure? Remove(this ISourceRepository repository, PluginAddress plugin, RecordIdentity identity) =>
        repository.SaveChanges(repository.ChangesToRemove(plugin, identity));

    /// <summary>Saves <paramref name="changes"/> under the repository's mod folder as <see cref="EditSaving"/> does,
    /// or answers why they were not answered.</summary>
    public static SourceFailure? SaveChanges(this ISourceRepository repository, Answer<SourceChanges, SourceFailure> changes)
    {
        if (!changes.Holds(out var made, out var failure)) return failure;
        var (moves, deletions, documents) = made.Under(repository.ModFolder);
        EditSaving.Save(
            moves.Select(move => (move.From, move.To)), deletions, documents.Select(document => (document.Path, document.Text)));
        return null;
    }
}
