import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import detectEthereumProvider from '@metamask/detect-provider';

// Contract ABIs (simplified versions)
const VOTING_ABI = [
  "function getName() view returns (string)",
  "function getCandidates() view returns (string[])",
  "function getCommitDeadline() view returns (uint256)",
  "function getRevealDeadline() view returns (uint256)",
  "function getVotes(uint256) view returns (uint256)",
  "function getTotalVotes() view returns (uint256)",
  "function getWinner() view returns (uint256 winnerIdx, uint256 winnerVotes, bool tied)",
  "function hasVoted(address) view returns (bool)",
  "function hasCommitted(address) view returns (bool)",
  "function getCommit(address) view returns (bytes32)",
  "function commit(bytes32 hash)",
  "function reveal(uint256 candidateIndex, bytes32 salt)",
  "event VoteCommitted(address indexed voter, bytes32 hash)",
  "event VoteRevealed(address indexed voter, uint256 indexed candidateIndex)",
  "error InvalidRegistry()",
  "error NoCandidates()",
  "error InvalidDurations()",
  "error CommitPhaseOver()",
  "error CommitPhaseActive()",
  "error AlreadyVoted()",
  "error AlreadyCommitted()",
  "error NotEligible()",
  "error InvalidHash()",
  "error RevealPhaseOver()",
  "error InvalidCandidate()",
  "error HashMismatch()"
];

const VOTER_REGISTRY_ABI = [
  "function isEligible(address) view returns (bool)",
  "function addVoter(address)",
  "function removeVoter(address)",
  "event VoterAdded(address indexed voter)",
  "event VoterRemoved(address indexed voter)",
  "error InvalidAddress()",
  "error AlreadyEligible()"
];

const VOTING_INTERFACE = new ethers.Interface(VOTING_ABI);
const REGISTRY_INTERFACE = new ethers.Interface(VOTER_REGISTRY_ABI);
// NOTE: this ABI must include the ElectionCreated event — the election fetcher
// builds its filter from it. An event-less ABI makes factory.filters undefined
// and crashes the fetch effect (seen in dev on 2026-09-25).
const FACTORY_ABI = [
  "function createElection(string name, string[] candidates, uint256 commitDuration, uint256 revealDuration, address admin) returns (address, address)",
  "event ElectionCreated(address indexed voting, address indexed registry, string name, string[] candidates, uint256 commitDuration, uint256 revealDuration)"
];
const FACTORY_INTERFACE = new ethers.Interface(FACTORY_ABI);

// Decode custom errors (revert data) into a readable label; fall back to standard messages.
const describeError = (error) => {
  const data = error?.data || error?.info?.error?.data;
  if (data) {
    for (const iface of [VOTING_INTERFACE, REGISTRY_INTERFACE, FACTORY_INTERFACE]) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) return parsed.name;
      } catch (e) {
        // not this interface; keep trying
      }
    }
  }
  return error?.reason || error?.shortMessage || error?.message || String(error);
};

// Persist the raw salt string per account so voters can reveal after a page reload.
const SALT_STORAGE_PREFIX = "vote_salt_";
const savePendingSalt = (address, salt) => {
  try {
    localStorage.setItem(SALT_STORAGE_PREFIX + address.toLowerCase(), salt);
  } catch (e) {
    console.warn("Could not persist salt to localStorage:", e);
  }
};
const getPendingSalt = (address) => {
  try {
    return localStorage.getItem(SALT_STORAGE_PREFIX + address.toLowerCase()) || "";
  } catch (e) {
    console.warn("Could not read salt from localStorage:", e);
    return "";
  }
};
const clearPendingSalt = (address) => {
  try {
    localStorage.removeItem(SALT_STORAGE_PREFIX + address.toLowerCase());
  } catch (e) {
    console.warn("Could not clear salt from localStorage:", e);
  }
};

// Build the commit hash exactly as the contract expects:
// salt = keccak256(bytes(userString)); hash = keccak256(abi.encode(idx, salt))
const buildVoteHash = (candidateIndex, saltString) => {
  const salt = ethers.keccak256(ethers.toUtf8Bytes(saltString));
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "bytes32"], [candidateIndex, salt])
  );
};

export default function Home() {
  const [account, setAccount] = useState(null);
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [connected, setConnected] = useState(false);
  const [votingContract, setVotingContract] = useState(null);
  const [voterRegistryContract, setVoterRegistryContract] = useState(null);
  const [electionData, setElectionData] = useState(null);
  const [selectedCandidate, setSelectedCandidate] = useState(0);
  const [voteSalt, setVoteSalt] = useState('');
  const [showSalt, setShowSalt] = useState(false);
  const [voteHash, setVoteHash] = useState('');
  const [hasCommitted, setHasCommitted] = useState(false);
  const [hasRevealed, setHasRevealed] = useState(false);
  const [isEligible, setIsEligible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Contract addresses from environment variables
  const VOTING_ADDRESS = process.env.NEXT_PUBLIC_VOTING_ADDRESS || "";
  const VOTER_REGISTRY_ADDRESS = process.env.NEXT_PUBLIC_VOTER_REGISTRY_ADDRESS || "";
  const FACTORY_ADDRESS = process.env.NEXT_PUBLIC_FACTORY_ADDRESS || "";

  const [factory, setFactory] = useState(null);
  const [currentElection, setCurrentElection] = useState(null);
  const [elections, setElections] = useState([]);
  const [selectedVotingAddress, setSelectedVotingAddress] = useState('');

  useEffect(() => {
    connectWallet();
  }, []);

  // Init contracts first; data loads in the effect below once the contract
  // instances exist. (Calling loadElectionData() synchronously after
  // initializeContracts() reads stale null state and never retries — that
  // stuck eligibility on false in dev on 2026-09-25.)
  useEffect(() => {
    if (connected && signer) {
      initializeContracts();
    }
  }, [connected, signer]);

  useEffect(() => {
    if (connected && votingContract && voterRegistryContract && account) {
      loadElectionData();
    }
  }, [connected, votingContract, voterRegistryContract, account]);

  // Factory: load factory contract if address configured, optionally fetch elections
  useEffect(() => {
    if (!signer || !FACTORY_ADDRESS) return;
    try {
      const factoryCon = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, signer);
      setFactory(factoryCon);
    } catch (e) {
      console.error("Factory init error:", e);
    }
  }, [signer, FACTORY_ADDRESS]);

  // Fetch elections from factory
  useEffect(() => {
    if (!signer || !FACTORY_ADDRESS || !factory) return;
    if (!factory.filters || typeof factory.filters.ElectionCreated !== 'function') {
      console.error('Factory contract missing ElectionCreated event — check FACTORY_ABI');
      return;
    }
    let cancelled = false;
    const fetchElections = async () => {
      try {
        const filter = factory.filters.ElectionCreated();
        const events = await factory.queryFilter(filter, 0, 'latest');
        if (cancelled) return;
        const list = events.map(e => ({
          voting: e.args.voting,
          registry: e.args.registry,
          name: e.args.name
        }));
        setElections(list);
        if (list.length > 0) {
          setSelectedVotingAddress((prev) => prev || list[0].voting);
        }
      } catch (e) {
        console.error('Factory events error:', e);
      }
    };
    fetchElections();
    return () => { cancelled = true; };
  }, [factory, signer, FACTORY_ADDRESS]);

  useEffect(() => {
    if (!connected || !votingContract) return;

    // Listen for VoteCommitted events from the contract
    votingContract.on("VoteCommitted", (voter, hash, event) => {
      logEventToBackend({ type: "commit", voter, hash });
      loadElectionData(); // Refresh immediately
      setSuccess("Vote committed confirmed!");
    });

    // Listen for VoteRevealed events from the contract
    votingContract.on("VoteRevealed", (voter, candidateIndex, event) => {
      logEventToBackend({ type: "reveal", voter, candidateIndex: Number(candidateIndex) });
      loadElectionData(); // Refresh immediately
      setSuccess("Vote revealed confirmed!");
    });

    // Cleanup on unmount
    return () => {
      votingContract.removeAllListeners("VoteCommitted");
      votingContract.removeAllListeners("VoteRevealed");
    };
  }, [connected, votingContract]);

  const connectWallet = async () => {
    try {
      const detectedProvider = await detectEthereumProvider();
      if (!detectedProvider) {
        setError('MetaMask is not installed');
        return;
      }
      
      const ethersProvider = new ethers.BrowserProvider(detectedProvider);
      setProvider(ethersProvider);

      const accounts = await detectedProvider.request({ method: 'eth_requestAccounts' });
      if (accounts.length > 0) {
        setAccount(accounts[0]);
        setConnected(true);
        setError(''); // clear stale errors (e.g. an earlier rejected auto-connect)
        const signer = await ethersProvider.getSigner();
        setSigner(signer);
      }
    } catch (error) {
      setError('Error connecting wallet: ' + error.message);
    }
  };

  const initializeContracts = () => {
    if (!signer) return;
    
    // Validate contract addresses are configured
    if (!VOTING_ADDRESS || !VOTER_REGISTRY_ADDRESS) {
      setError('Contract addresses not configured. Please check your .env.local file or redeploy contracts.');
      return;
    }
    
    const voting = new ethers.Contract(VOTING_ADDRESS, VOTING_ABI, signer);
    const voterRegistry = new ethers.Contract(VOTER_REGISTRY_ADDRESS, VOTER_REGISTRY_ABI, signer);
    
    // Clean up existing listeners
    voting.removeAllListeners("VoteCommitted");
    voting.removeAllListeners("VoteRevealed");
    
    // Set up event listeners (only for backend logging)
    voting.on("VoteCommitted", (voter, hash, event) => {
      const eventData = {
        type: 'commit',
        voter,
        hash,
        timestamp: new Date().toISOString(),
        transactionHash: event?.log?.transactionHash || ''
      };
      console.log("Vote Committed Event:", eventData);
      logEventToBackend(eventData);
      setSuccess(`Vote committed successfully! Transaction confirmed.`);
    });
    
    voting.on("VoteRevealed", (voter, candidateIndex, event) => {
      const eventData = {
        type: 'reveal',
        voter,
        candidateIndex,
        timestamp: new Date().toISOString(),
        transactionHash: event?.log?.transactionHash || ''
      };
      console.log("Vote Revealed Event:", eventData);
      logEventToBackend(eventData);
      setSuccess(`Vote revealed successfully! Your vote has been counted.`);
    });
    
    setVotingContract(voting);
    setVoterRegistryContract(voterRegistry);
  };

  const loadElectionData = async () => {
    if (!votingContract || !voterRegistryContract || !account) return;
    
    try {
      setLoading(true);
      
      const [name, candidates, commitDeadline, revealDeadline, voted, committed, eligible] = await Promise.all([
        votingContract.getName(),
        votingContract.getCandidates(),
        votingContract.getCommitDeadline(),
        votingContract.getRevealDeadline(),
        votingContract.hasVoted(account),
        votingContract.hasCommitted(account),
        voterRegistryContract.isEligible(account)
      ]);

      const votes = await Promise.all(
        candidates.map((_, index) => votingContract.getVotes(index))
      );

      const [winnerIdx, winnerVotes, tied] = await votingContract.getWinner();
      const totalVotes = await votingContract.getTotalVotes();

      const electionDataObj = {
        name,
        candidates,
        commitDeadline: Number(commitDeadline),
        revealDeadline: Number(revealDeadline),
        votes: votes.map(v => Number(v)),
        winnerIdx: Number(winnerIdx),
        winnerVotes: Number(winnerVotes),
        tied,
        totalVotes: Number(totalVotes)
      };

      setElectionData(electionDataObj);
      setHasRevealed(voted);
      setHasCommitted(committed);
      setIsEligible(eligible);
      
      // Set appropriate message based on voting state
      if (voted) {
        clearPendingSalt(account);
        setSuccess('You have already voted and revealed your vote in this election.');
      } else if (committed) {
        // Restore the saved salt so the voter can reveal after a page reload
        const savedSalt = getPendingSalt(account);
        if (savedSalt && !voteSalt) {
          setVoteSalt(savedSalt);
        }
        setSuccess('You have committed your vote. Wait for the reveal phase to reveal your vote.');
      } else {
        // User hasn't committed yet, clear form
        setVoteHash('');
        setVoteSalt('');
        setSelectedCandidate(0);
      }
      
    } catch (error) {
      setError('Error loading election data: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const generateVoteHash = () => {
    if (!voteSalt) {
      setError('Please enter a salt value');
      return;
    }

    setVoteHash(buildVoteHash(selectedCandidate, voteSalt));
    setSuccess('Vote hash generated. You can now commit your vote.');
  };

  const commitVote = async () => {
    if (!voteSalt) {
      setError('Please enter a secret salt value first');
      return;
    }
    const hash = buildVoteHash(selectedCandidate, voteSalt);

    try {
      setLoading(true);
      setError('');
      setSuccess('Sending transaction...');
      
      const tx = await votingContract.commit(hash);
      console.log(' Transaction sent:', tx.hash);
      
      setSuccess(`Transaction sent! Hash: ${tx.hash.slice(0, 10)}... Waiting for confirmation...`);
      
      const receipt = await tx.wait();
      console.log(' Transaction confirmed:', receipt);
      
      // Set local state. Keep the salt so the voter can reveal in the next phase.
      setHasCommitted(true);
      setVoteHash('');
      savePendingSalt(account, voteSalt);
      setSuccess(`Vote committed successfully! Block: ${receipt.blockNumber}. Remember your exact salt string for the reveal phase.`);
      
      // Verify on blockchain
      const committed = await votingContract.hasCommitted(account);
      console.log('Blockchain commit status:', committed);
      
    } catch (error) {
      console.error(' Commit error:', error);
      setError('Error committing vote: ' + describeError(error));
    } finally {
      setLoading(false);
    }
  };

  const revealVote = async () => {
    // Prefer the stored salt; fall back to whatever the user typed.
    const saltString = (voteSalt && voteSalt.trim()) || getPendingSalt(account);
    if (!saltString) {
      setError('Please enter the same salt value used during commit');
      return;
    }

    // Contract expects salt = keccak256(bytes(rawString)), not the raw string.
    const salt = ethers.keccak256(ethers.toUtf8Bytes(saltString));

    try {
      setLoading(true);
      setError('');
      setSuccess('Revealing vote...');
      
      const tx = await votingContract.reveal(selectedCandidate, salt);
      console.log(' Reveal transaction sent:', tx.hash);
      
      setSuccess(`Reveal transaction sent! Hash: ${tx.hash.slice(0, 10)}...`);
      
      const receipt = await tx.wait();
      console.log(' Reveal confirmed:', receipt);
      
      setHasRevealed(true);
      setSuccess(`Vote revealed successfully! Block: ${receipt.blockNumber}`);
      
      // Reveal succeeded: safe to clear the stored salt.
      setVoteSalt('');
      clearPendingSalt(account);
      loadElectionData();
      setTimeout(() => {
        loadElectionData();
      }, 1000);
      setTimeout(() => {
        loadElectionData();
      }, 3000);
      
    } catch (error) {
      console.error(' Reveal error:', error);
      setError('Error revealing vote: ' + describeError(error));
    } finally {
      setLoading(false);
    }
  };

  // Backend audit-log base URL. Configured via env; localhost fallback is dev-only.
  const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:5000';

  const logEventToBackend = async (eventData) => {
    try {
      await fetch(`${BACKEND_URL}/api/vote-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(eventData)
      });
    } catch (error) {
      console.error('Failed to log event to backend:', error);
    }
  };

  const handleDisconnect = () => {
    setAccount(null);
    setConnected(false);
    setVotingContract(null);
    setVoterRegistryContract(null);
    setElectionData(null);
    setHasCommitted(false);
    setHasRevealed(false);
    setIsEligible(false);
  };

  const getCurrentPhase = () => {
    if (!electionData) return 'Loading...';
    const now = Math.floor(Date.now() / 1000);
    if (now < electionData.commitDeadline) return 'Commit Phase';
    if (now < electionData.revealDeadline) return 'Reveal Phase';
    return 'Election Ended';
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif', maxWidth: '800px', margin: '0 auto' }}>
      <h1>Blockchain Voting System</h1>
      
      {/* Wallet Connection */}
      <div style={{ marginBottom: '20px', padding: '15px', border: '1px solid #ccc', borderRadius: '8px' }}>
        {connected && account ? (
          <>
            <p><strong>Connected Account:</strong> {account.slice(0, 6)}...{account.slice(-4)}</p>
            <p><strong>Active Election:</strong> {selectedVotingAddress ? selectedVotingAddress.slice(0, 6) + '...' + selectedVotingAddress.slice(-4) : VOTING_ADDRESS ? VOTING_ADDRESS.slice(0, 6) + '...' + VOTING_ADDRESS.slice(-4) : 'None'}</p>
            {elections.length > 1 && (
              <div style={{ margin: '8px 0' }}>
                <label><strong>Switch Election:</strong></label>
                <select
                  onChange={(e) => setSelectedVotingAddress(e.target.value)}
                  value={selectedVotingAddress}
                  style={{ marginLeft: '8px', padding: '4px 8px', cursor: 'pointer' }}
                >
                  <option value="">-- Select Election --</option>
                  {elections.map((e, i) => (
                    <option key={i} value={e.voting}>
                      {e.name} ({e.voting.slice(0, 6)}...{e.voting.slice(-4)})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <p><strong>Eligibility:</strong> {isEligible ? '✅ Eligible to vote' : '❌ Not eligible'}</p>
            <button onClick={handleDisconnect} style={{ padding: '10px 20px', cursor: 'pointer', backgroundColor: '#dc3545', color: 'white', border: 'none', borderRadius: '4px' }}>
              Disconnect
            </button>
          </>
        ) : (
          <div>
            <p>MetaMask wallet not connected.</p>
            <button onClick={connectWallet} style={{ padding: '10px 20px', cursor: 'pointer', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '4px' }}>
              Connect Wallet
            </button>
          </div>
        )}
      </div>

      {/* Messages */}
      {error && <div style={{ padding: '10px', backgroundColor: '#f8d7da', color: '#721c24', borderRadius: '4px', marginBottom: '10px' }}>{error}</div>}
      {success && <div style={{ padding: '10px', backgroundColor: '#d4edda', color: '#155724', borderRadius: '4px', marginBottom: '10px' }}>{success}</div>}

      {/* Election Information */}
      {electionData && (
        <div style={{ marginBottom: '20px', padding: '15px', border: '1px solid #ddd', borderRadius: '8px' }}>
          <h2>{electionData.name}</h2>
          <p><strong>Current Phase:</strong> {getCurrentPhase()}</p>
          <p><strong>Commit Deadline:</strong> {new Date(electionData.commitDeadline * 1000).toLocaleString()}</p>
          <p><strong>Reveal Deadline:</strong> {new Date(electionData.revealDeadline * 1000).toLocaleString()}</p>
        </div>
      )}

      {/* Voting Interface */}
      {connected && isEligible && electionData && !hasRevealed && (
        <div style={{ marginBottom: '20px', padding: '15px', border: '1px solid #ddd', borderRadius: '8px' }}>
          <h3>Cast Your Vote</h3>
          
          {hasCommitted ? (
            <div style={{ padding: '15px', backgroundColor: '#fff3cd', border: '1px solid #ffeaa7', borderRadius: '4px', marginBottom: '15px' }}>
              <h4> Vote Committed Successfully!</h4>
              <p>Your vote has been committed to the blockchain. Please wait for the reveal phase to reveal your vote.</p>
              <p><strong>Current Phase:</strong> {getCurrentPhase()}</p>
              {getCurrentPhase() === 'Reveal Phase' && (
                <div style={{ marginTop: '10px' }}>
                  <label><strong>Enter your original salt to reveal:</strong></label>
                  <input 
                    type={showSalt ? "text" : "password"} 
                    value={voteSalt}
                    onChange={(e) => setVoteSalt(e.target.value)}
                    placeholder="Enter the same salt used during commit"
                    style={{ marginLeft: '10px', padding: '5px', width: '200px' }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowSalt((s) => !s)}
                    style={{ marginLeft: '8px', padding: '5px 10px', cursor: 'pointer' }}
                  >
                    {showSalt ? 'Hide' : 'Show'}
                  </button>
                  {voteSalt ? (
                    <p><small>The salt is saved in this browser and will be used for reveal.</small></p>
                  ) : (
                    <p><small>Your saved salt will be restored automatically for the reveal.</small></p>
                  )}
                  <button 
                    onClick={revealVote}
                    disabled={loading || (!voteSalt && !getPendingSalt(account))}
                    style={{ padding: '10px 20px', marginLeft: '10px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '4px' }}
                  >
                    {loading ? 'Processing...' : 'Reveal Vote'}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Candidate Selection */}
              <div style={{ marginBottom: '15px' }}>
                <label><strong>Select Candidate:</strong></label>
                <select 
                  value={selectedCandidate} 
                  onChange={(e) => setSelectedCandidate(Number(e.target.value))}
                  style={{ marginLeft: '10px', padding: '5px' }}
                >
                  {electionData.candidates.map((candidate, index) => (
                    <option key={index} value={index}>{candidate}</option>
                  ))}
                </select>
              </div>

              {/* Salt Input */}
              <div style={{ marginBottom: '15px' }}>
                <label><strong>Salt (secret value):</strong></label>
                <input 
                  type={showSalt ? "text" : "password"} 
                  value={voteSalt}
                  onChange={(e) => setVoteSalt(e.target.value)}
                  placeholder="Enter a secret salt"
                  style={{ marginLeft: '10px', padding: '5px', width: '200px' }}
                />
                <button
                  type="button"
                  onClick={() => setShowSalt((s) => !s)}
                  style={{ marginLeft: '8px', padding: '5px 10px', cursor: 'pointer' }}
                >
                  {showSalt ? 'Hide' : 'Show'}
                </button>
              </div>

              {/* Commit Phase */}
              {getCurrentPhase() === 'Commit Phase' && (
                <div>
                  <button 
                    onClick={generateVoteHash}
                    style={{ padding: '10px 20px', marginRight: '10px', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '4px' }}
                  >
                    Generate Hash
                  </button>
                  {voteHash && (
                    <div style={{ marginTop: '10px', padding: '10px', backgroundColor: '#f8f9fa', borderRadius: '4px' }}>
                      <small><strong>Generated Hash:</strong> {voteHash}</small>
                    </div>
                  )}
                  <button 
                    onClick={commitVote}
                    disabled={!voteHash || loading}
                    style={{ padding: '10px 20px', marginTop: '10px', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '4px' }}
                  >
                    {loading ? 'Processing...' : 'Commit Vote'}
                  </button>
                </div>
              )}

              {/* Reveal Phase - but user hasn't committed */}
              {getCurrentPhase() === 'Reveal Phase' && (
                <div style={{ padding: '15px', backgroundColor: '#f8d7da', border: '1px solid #f5c6cb', borderRadius: '4px' }}>
                  <h4>Commit Phase Ended</h4>
                  <p>The commit phase has ended. You must have committed your vote during the commit phase to participate in the reveal phase.</p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Message for users who have already voted */}
      {connected && hasRevealed && (
        <div style={{ marginBottom: '20px', padding: '15px', backgroundColor: '#d1ecf1', border: '1px solid #bee5eb', borderRadius: '8px' }}>
          <h3> Vote Completed</h3>
          <p>You have successfully cast and revealed your vote in this election.</p>
        </div>
      )}

      {/* Message for ineligible users */}
      {connected && !isEligible && (
        <div style={{ marginBottom: '20px', padding: '15px', backgroundColor: '#f8d7da', border: '1px solid #f5c6cb', borderRadius: '8px' }}>
          <h3>Not Eligible to Vote</h3>
          <p>Your account is not registered as an eligible voter for this election.</p>
        </div>
      )}

      {/* Results */}
      {electionData && (
        <div style={{ padding: '15px', border: '1px solid #ddd', borderRadius: '8px' }}>
          <h3>Current Results</h3>
          {electionData.candidates.map((candidate, index) => (
            <div key={index} style={{ marginBottom: '10px' }}>
              <strong>{candidate}:</strong> {electionData.votes[index]} votes
            </div>
          ))}
          {electionData.totalVotes === 0 ? (
            <p><strong>No votes cast yet.</strong></p>
          ) : electionData.tied ? (
            <p><strong>Current standing:</strong> Tie between top candidates with {electionData.winnerVotes} votes each.</p>
          ) : (
            <p><strong>Current leader:</strong> {electionData.candidates[electionData.winnerIdx]} with {electionData.winnerVotes} votes.</p>
          )}
          <p><strong>Total votes:</strong> {electionData.totalVotes}</p>
        </div>
      )}

      {hasRevealed && (
        <div style={{ padding: '15px', backgroundColor: '#d1ecf1', border: '1px solid #bee5eb', borderRadius: '8px', marginTop: '20px' }}>
          <h4> Your vote has been successfully cast and revealed!</h4>
        </div>
      )}
    </div>
  );
}