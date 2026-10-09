using System.Diagnostics.CodeAnalysis;

namespace MEditService.RepositoriesLib;

/// <summary>What a read or write of a repository answers (ADR-0019): its value, or why it stopped.</summary>
public abstract class Answer<T, TFailure>
    where TFailure : class
{
    private Answer()
    {
    }

    public static implicit operator Answer<T, TFailure>(TFailure failure) => new Failed(failure);

    public static implicit operator Answer<T, TFailure>(T value) => new Answered(value);

    public abstract bool Holds([MaybeNullWhen(false)] out T value, [NotNullWhen(false)] out TFailure? failure);

    /// <summary>What <paramref name="next"/> answers of this value, or this answer's failure.</summary>
    public Answer<TNext, TFailure> Then<TNext>(Func<T, Answer<TNext, TFailure>> next) =>
        Holds(out var value, out var failure) ? next(value) : failure;

    private sealed class Answered(T answer) : Answer<T, TFailure>
    {
        public override bool Holds([MaybeNullWhen(false)] out T value, [NotNullWhen(false)] out TFailure? failure)
        {
            (value, failure) = (answer, null);
            return true;
        }
    }

    private sealed class Failed(TFailure stopped) : Answer<T, TFailure>
    {
        public override bool Holds([MaybeNullWhen(false)] out T value, [NotNullWhen(false)] out TFailure? failure)
        {
            (value, failure) = (default, stopped);
            return false;
        }
    }
}
